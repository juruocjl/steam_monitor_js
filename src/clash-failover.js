const fs = require('fs');
const http = require('http');
const https = require('https');

const NON_LEAF_PROXY_TYPES = new Set([
  'selector',
  'urltest',
  'fallback',
  'loadbalance',
  'relay',
  'direct',
  'reject',
  'rejectdrop',
  'pass',
  'compatible',
  'dns',
]);

const BUILTIN_NON_LEAF_NAMES = new Set([
  'Auto',
  'Fallback',
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'PASS',
  'COMPATIBLE',
  'GLOBAL',
]);

const DEFAULT_FAILED_COOLDOWN_MS = 30 * 60 * 1000;

function parseClashSecret(content) {
  const match = String(content || '').match(/^secret:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m);
  return match ? match[1] ?? match[2] ?? match[3] ?? '' : '';
}

function normalizeNameList(value, fallback = []) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (value === undefined) {
    return [...fallback];
  }
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeCmEndpointToUrl(endpoint) {
  const raw = String(endpoint || '').trim();
  if (!raw) {
    return null;
  }

  let normalized = raw;
  if (/^wss?:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
  } else if (!/^https?:\/\//i.test(normalized)) {
    if (!/:443$/i.test(normalized)) {
      return null;
    }
    normalized = `https://${normalized}/cmsocket/`;
  }

  try {
    const parsed = new URL(normalized);
    if (!parsed.hostname) {
      return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    if (!parsed.pathname || parsed.pathname === '/') {
      parsed.pathname = '/cmsocket/';
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

class ClashFailover {
  constructor(options = {}) {
    this.enabled = Boolean(options.enabled);
    this.controllerUrl = String(options.controllerUrl || 'http://127.0.0.1:9090').replace(/\/$/, '');
    this.secretFile = options.secretFile || '';
    this.group = options.group || 'E-IX';
    this.upstreamGroups = normalizeNameList(options.upstreamGroups, ['Steam']);
    this.upstreamGroupsSet = new Set(this.upstreamGroups);
    this.candidates = Array.isArray(options.candidates) ? options.candidates.filter(Boolean) : [];
    this.testUrl = options.testUrl || 'https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/?cellid=0';
    this.cmTestUrls = normalizeNameList(options.cmTestUrls, []);
    this.dynamicCmUrls = [];
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || 8000);
    this.failedCooldownMs = Math.max(1000, Number(options.failedCooldownMs) || DEFAULT_FAILED_COOLDOWN_MS);
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.logger = options.logger || console;
    this.triedSelections = new Set();
    this.failedSelections = new Map();
    this.pendingCurrentFailure = null;
    this.inFlight = null;
    this.currentSelection = null;
    this.lastAlignedUpstreams = [];
    this.lastResult = null;
  }

  resetCycle() {
    this.triedSelections.clear();
    this.failedSelections.clear();
    this.pendingCurrentFailure = null;
  }

  recordLoginFailure(reason = 'login-failed', selection = null) {
    const at = this.now();
    const normalizedReason = String(reason || 'login-failed');
    const target = selection || this.currentSelection || null;
    this.pendingCurrentFailure = {
      at,
      reason: normalizedReason,
      selection: target,
    };
    if (target) {
      this.failedSelections.set(target, {
        at,
        reason: normalizedReason,
      });
    }
  }

  recordCmEndpoint(endpoint) {
    const url = normalizeCmEndpointToUrl(endpoint);
    if (!url) {
      return null;
    }
    this.dynamicCmUrls = [url, ...this.dynamicCmUrls.filter((existing) => existing !== url)].slice(0, 3);
    return url;
  }

  snapshot() {
    return {
      enabled: this.enabled,
      group: this.enabled ? this.group : null,
      upstreamGroups: this.enabled ? [...this.upstreamGroups] : [],
      dynamicCandidates: this.candidates.includes('*'),
      cmProbeEnabled: this.#getActiveCmTestUrls().length > 0,
      currentSelection: this.currentSelection,
      triedSelections: Array.from(this.triedSelections),
      failedSelections: Array.from(this.failedSelections.entries()).map(([name, info]) => ({
        name,
        at: new Date(info.at).toISOString(),
        reason: info.reason,
      })),
      lastAlignedUpstreams: [...this.lastAlignedUpstreams],
      lastResult: this.lastResult,
    };
  }

  async ensureUpstreamAligned() {
    if (!this.enabled || this.upstreamGroups.length === 0) {
      return [];
    }

    try {
      const { proxies } = await this.#fetchGroupAndProxies();
      const aligned = await this.#alignUpstreamGroups(proxies);
      this.lastAlignedUpstreams = aligned;
      return aligned;
    } catch (err) {
      this.logger.warn(`Clash 上游策略组对齐检查失败: ${err.message}`);
      return [];
    }
  }

  async failover(reason) {
    if (!this.enabled) {
      return { switched: false, reason: 'disabled' };
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.#failover(reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async ensureAvailable(reason) {
    if (!this.enabled) {
      return { available: true, switched: false, reason: 'disabled' };
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.#ensureAvailable(reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async #ensureAvailable(reason) {
    this.triedSelections.clear();
    try {
      const { group, proxies } = await this.#fetchGroupAndProxies();
      const current = group?.now || null;
      const allowed = new Set(group?.all || []);
      this.currentSelection = current;

      const alignedUpstreams = await this.#alignUpstreamGroups(proxies);
      this.lastAlignedUpstreams = alignedUpstreams;
      this.#consumePendingFailure(current, alignedUpstreams);
      this.#pruneExpiredFailures();

      const currentEligible = Boolean(current) && this.#isEligibleSelection(current, allowed, proxies);
      const currentFailed = Boolean(current) && this.failedSelections.has(current);
      let currentWebApiFallback = null;

      if (current) {
        this.triedSelections.add(current);
        if (!currentEligible) {
          this.logger.warn(`Clash 当前节点为非落地策略组或不在候选池: ${current}，准备迁移到真实代理节点`);
        } else if (currentFailed) {
          const failureInfo = this.failedSelections.get(current);
          this.logger.warn(
            `Clash 当前节点近期登录失败，跳过原地复用: ${current} (${failureInfo?.reason || 'login-failed'})`
          );
        } else {
          try {
            const probe = await this.#probeNode(current);
            if (probe.cmVerified || this.#getActiveCmTestUrls().length === 0) {
              this.lastResult = {
                available: true,
                switched: false,
                at: new Date().toISOString(),
                reason,
                current,
                delay: probe.delay,
                cmVerified: probe.cmVerified,
                alignedUpstreams,
              };
              return this.lastResult;
            }

            currentWebApiFallback = {
              candidate: current,
              delay: probe.delay,
              cmError: probe.cmError,
            };
            this.logger.warn(
              `Clash 当前节点 Web API 可达但 Steam CM 探测失败: ${current}: ${probe.cmError || 'CM 不可达'}`
            );
          } catch (err) {
            this.logger.warn(`Clash 当前节点不可用: ${current}: ${err.message}`);
          }
        }
      }

      const { allEligible, freshCandidates, recycledCandidates } = this.#partitionCandidates(allowed, current, proxies);

      const freshPick = await this.#pickAndSwitchCandidate(freshCandidates, current, reason, {
        recoveryMode: true,
        alignedUpstreams,
      });
      if (freshPick) {
        return freshPick;
      }

      if (currentWebApiFallback && !currentFailed) {
        this.logger.warn(
          `没有通过 Steam CM 增强探测的其它节点，暂保留当前 Web API 可达节点: ${current}`
        );
        this.lastResult = {
          available: true,
          switched: false,
          at: new Date().toISOString(),
          reason,
          current,
          delay: currentWebApiFallback.delay,
          cmVerified: false,
          cmFallback: true,
          alignedUpstreams,
        };
        return this.lastResult;
      }

      const recycledPick = await this.#pickAndSwitchCandidate(recycledCandidates, current, reason, {
        recoveryMode: true,
        alignedUpstreams,
        clearFailedOnSelect: true,
      });
      if (recycledPick) {
        return recycledPick;
      }

      if (allEligible.length === 1 && current && currentEligible && currentFailed && !currentWebApiFallback) {
        try {
          const probe = await this.#probeNode(current);
          this.failedSelections.delete(current);
          this.lastResult = {
            available: true,
            switched: false,
            at: new Date().toISOString(),
            reason,
            current,
            delay: probe.delay,
            cmVerified: probe.cmVerified,
            alignedUpstreams,
          };
          return this.lastResult;
        } catch (err) {
          this.logger.warn(`Clash 唯一候选节点仍不可用: ${current}: ${err.message}`);
        }
      }

      const totalCandidates = freshCandidates.length + recycledCandidates.length;
      this.lastResult = {
        available: false,
        switched: false,
        at: new Date().toISOString(),
        reason,
        from: current,
        alignedUpstreams,
        error: totalCandidates === 0 ? '没有可用的候选节点' : '当前及候选节点均不可用',
      };
      return this.lastResult;
    } catch (err) {
      this.lastResult = {
        available: false,
        switched: false,
        at: new Date().toISOString(),
        reason,
        error: err.message,
      };
      this.logger.error(`Clash 恢复探测失败: ${err.message}`);
      return this.lastResult;
    }
  }

  async #failover(reason) {
    try {
      const { group, proxies } = await this.#fetchGroupAndProxies();
      const current = group?.now || null;
      const allowed = new Set(group?.all || []);
      this.currentSelection = current;

      const alignedUpstreams = await this.#alignUpstreamGroups(proxies);
      this.lastAlignedUpstreams = alignedUpstreams;
      this.#consumePendingFailure(current, alignedUpstreams);
      this.#pruneExpiredFailures();

      if (current) {
        this.triedSelections.add(current);
      }

      const { freshCandidates, recycledCandidates } = this.#partitionCandidates(allowed, current, proxies);
      const orderedCandidates = [...freshCandidates, ...recycledCandidates];

      const picked = await this.#pickAndSwitchCandidate(orderedCandidates, current, reason, {
        recoveryMode: false,
        alignedUpstreams,
        clearFailedOnSelect: true,
      });
      if (picked) {
        return picked;
      }

      this.lastResult = {
        switched: false,
        at: new Date().toISOString(),
        reason,
        from: current,
        alignedUpstreams,
        error: orderedCandidates.length === 0 ? '没有未尝试的候选节点' : '候选节点均不可用',
      };
      return this.lastResult;
    } catch (err) {
      this.lastResult = {
        switched: false,
        at: new Date().toISOString(),
        reason,
        error: err.message,
      };
      this.logger.error(`Clash 节点故障转移失败: ${err.message}`);
      return this.lastResult;
    }
  }

  async #pickAndSwitchCandidate(candidates, current, reason, options = {}) {
    const {
      recoveryMode = false,
      alignedUpstreams = [],
      clearFailedOnSelect = false,
    } = options;
    const cmEnabled = this.#getActiveCmTestUrls().length > 0;
    let webApiFallback = null;

    for (const candidate of candidates) {
      this.triedSelections.add(candidate);
      try {
        const probe = await this.#probeNode(candidate);
        if (cmEnabled && !probe.cmVerified) {
          if (!webApiFallback) {
            webApiFallback = { candidate, probe };
          }
          this.logger.warn(
            `Clash ${recoveryMode ? '恢复' : ''}候选节点仅过 Web API 但 Steam CM 不可达，先跳过: ${candidate}: ${
              probe.cmError || 'CM 不可达'
            }`
          );
          continue;
        }

        return await this.#switchToCandidate(candidate, current, reason, probe, {
          recoveryMode,
          alignedUpstreams,
          clearFailedOnSelect,
          cmFallback: false,
        });
      } catch (err) {
        this.logger.warn(`Clash ${recoveryMode ? '恢复' : ''}候选节点不可用: ${candidate}: ${err.message}`);
      }
    }

    if (webApiFallback) {
      this.logger.warn(
        `所有候选节点 Steam CM 增强探测均未通过，安全降级选用首个 Web API 可达节点: ${webApiFallback.candidate}`
      );
      return await this.#switchToCandidate(webApiFallback.candidate, current, reason, webApiFallback.probe, {
        recoveryMode,
        alignedUpstreams,
        clearFailedOnSelect,
        cmFallback: true,
      });
    }

    return null;
  }

  async #switchToCandidate(candidate, current, reason, probe, options = {}) {
    const {
      recoveryMode = false,
      alignedUpstreams = [],
      clearFailedOnSelect = false,
      cmFallback = false,
    } = options;

    await this.#request(`/proxies/${encodeURIComponent(this.group)}`, 'PUT', { name: candidate });
    this.currentSelection = candidate;
    if (clearFailedOnSelect) {
      this.failedSelections.delete(candidate);
    }

    const result = {
      switched: true,
      at: new Date().toISOString(),
      reason,
      from: current,
      to: candidate,
      delay: probe.delay,
      cmVerified: probe.cmVerified,
      alignedUpstreams,
    };
    if (recoveryMode) {
      result.available = true;
    }
    if (cmFallback) {
      result.cmFallback = true;
    }

    this.lastResult = result;
    this.logger.warn(
      `Clash ${recoveryMode ? '恢复探测切换成功' : '节点故障转移成功'}: ${this.group} ${
        current || 'unknown'
      } -> ${candidate}, Steam ${probe.cmVerified ? 'CM' : 'WebAPI'} ${probe.delay}ms`
    );
    return this.lastResult;
  }

  async #fetchGroupAndProxies() {
    try {
      const response = await this.#request('/proxies');
      const proxies = response && typeof response.proxies === 'object' ? response.proxies : null;
      if (proxies && proxies[this.group]) {
        return { group: proxies[this.group], proxies };
      }
    } catch (err) {
      if (!/HTTP 404\b/.test(err.message)) {
        throw err;
      }
    }

    const group = await this.#request(`/proxies/${encodeURIComponent(this.group)}`);
    return { group, proxies: null };
  }

  async #alignUpstreamGroups(proxies) {
    if (!proxies || this.upstreamGroups.length === 0) {
      return [];
    }

    const aligned = [];
    for (const upstreamName of this.upstreamGroups) {
      const upstream = proxies[upstreamName];
      if (!upstream) {
        continue;
      }
      if (String(upstream.type || '').toLowerCase() !== 'selector') {
        continue;
      }
      if (!Array.isArray(upstream.all) || !upstream.all.includes(this.group)) {
        continue;
      }
      if (upstream.now === this.group) {
        continue;
      }

      const previous = upstream.now || null;
      await this.#request(`/proxies/${encodeURIComponent(upstreamName)}`, 'PUT', { name: this.group });
      upstream.now = this.group;
      aligned.push({
        group: upstreamName,
        from: previous,
        to: this.group,
      });
      this.logger.warn(
        `Clash 上游策略组已偏离，自动对齐: ${upstreamName} ${previous || 'unknown'} -> ${this.group}`
      );
    }

    return aligned;
  }

  #consumePendingFailure(current, alignedUpstreams) {
    const pending = this.pendingCurrentFailure;
    this.pendingCurrentFailure = null;
    if (!pending) {
      return;
    }

    if (alignedUpstreams.length > 0) {
      if (current && this.failedSelections.get(current)?.at === pending.at) {
        this.failedSelections.delete(current);
      }
      if (pending.selection && this.failedSelections.get(pending.selection)?.at === pending.at) {
        this.failedSelections.delete(pending.selection);
      }
      return;
    }

    if (current) {
      this.failedSelections.set(current, {
        at: pending.at,
        reason: pending.reason,
      });
    }
    if (pending.selection && pending.selection !== current) {
      this.failedSelections.set(pending.selection, {
        at: pending.at,
        reason: pending.reason,
      });
    }
  }

  #pruneExpiredFailures() {
    const now = this.now();
    for (const [name, entry] of this.failedSelections.entries()) {
      if (now - entry.at >= this.failedCooldownMs) {
        this.failedSelections.delete(name);
      }
    }
  }

  #isExplicitCandidate(name) {
    return this.candidates.includes(name);
  }

  #isEligibleSelection(name, allowed, proxies) {
    if (!name || !allowed.has(name)) {
      return false;
    }

    if (this.#isExplicitCandidate(name)) {
      return true;
    }

    if (!this.candidates.includes('*')) {
      return false;
    }

    if (name === this.group || this.upstreamGroupsSet.has(name)) {
      return false;
    }

    if (proxies && proxies[name]) {
      const meta = proxies[name];
      const type = String(meta.type || '').toLowerCase();
      if (NON_LEAF_PROXY_TYPES.has(type) || Array.isArray(meta.all)) {
        return false;
      }
      return true;
    }

    return !BUILTIN_NON_LEAF_NAMES.has(name);
  }

  #partitionCandidates(allowed, current, proxies) {
    const configured = this.candidates.filter((candidate) => candidate !== '*');
    const rawPool = this.candidates.includes('*') ? [...configured, ...allowed] : configured;
    const allEligible = Array.from(new Set(rawPool)).filter((candidate) =>
      this.#isEligibleSelection(candidate, allowed, proxies)
    );
    const otherEligible = allEligible.filter(
      (candidate) => candidate !== current && !this.triedSelections.has(candidate)
    );

    const freshCandidates = [];
    const recycledCandidates = [];
    for (const candidate of otherEligible) {
      if (this.failedSelections.has(candidate)) {
        recycledCandidates.push(candidate);
      } else {
        freshCandidates.push(candidate);
      }
    }

    recycledCandidates.sort((a, b) => {
      const atA = this.failedSelections.get(a)?.at ?? 0;
      const atB = this.failedSelections.get(b)?.at ?? 0;
      return atA - atB;
    });

    return {
      allEligible,
      freshCandidates,
      recycledCandidates,
    };
  }

  #getActiveCmTestUrls() {
    return Array.from(new Set([...this.dynamicCmUrls, ...this.cmTestUrls])).slice(0, 5);
  }

  async #probeNode(candidate) {
    const apiDelay = await this.#probeUrl(candidate, this.testUrl, '200-299');
    const cmUrls = this.#getActiveCmTestUrls();
    if (cmUrls.length === 0) {
      return {
        delay: apiDelay,
        apiDelay,
        cmVerified: false,
        cmUrl: null,
        cmError: null,
      };
    }

    let lastCmError = null;
    for (const cmUrl of cmUrls) {
      try {
        const cmDelay = await this.#probeUrl(candidate, cmUrl, '200-499');
        return {
          delay: cmDelay,
          apiDelay,
          cmVerified: true,
          cmUrl,
          cmError: null,
        };
      } catch (err) {
        lastCmError = err;
      }
    }

    return {
      delay: apiDelay,
      apiDelay,
      cmVerified: false,
      cmUrl: null,
      cmError: lastCmError?.message || 'Steam CM 不可达',
    };
  }

  async #probeUrl(candidate, url, expected) {
    const query = new URLSearchParams({
      timeout: String(this.timeoutMs),
      url,
      expected,
    });
    const probe = await this.#request(
      `/proxies/${encodeURIComponent(candidate)}/delay?${query.toString()}`,
      'GET',
      null,
      this.timeoutMs + 2000
    );
    const delay = Number(probe?.delay);
    if (!Number.isFinite(delay) || delay <= 0) {
      throw new Error('节点探测没有返回有效延迟');
    }
    return delay;
  }

  #readSecret() {
    if (!this.secretFile) {
      return '';
    }
    return parseClashSecret(fs.readFileSync(this.secretFile, 'utf8'));
  }

  #request(pathname, method = 'GET', body = null, timeoutMs = this.timeoutMs) {
    const target = new URL(pathname, `${this.controllerUrl}/`);
    const payload = body === null ? null : JSON.stringify(body);
    const secret = this.#readSecret();
    const transport = target.protocol === 'https:' ? https : http;
    const headers = {
      Accept: 'application/json',
    };
    if (secret) {
      headers.Authorization = `Bearer ${secret}`;
    }
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    return new Promise((resolve, reject) => {
      const req = transport.request(target, { method, headers }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const responseText = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Clash API HTTP ${res.statusCode}${responseText ? `: ${responseText}` : ''}`));
            return;
          }
          if (!responseText) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(responseText));
          } catch (err) {
            reject(new Error(`Clash API 返回无效 JSON: ${err.message}`));
          }
        });
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Clash API 请求超时（${timeoutMs}ms）`));
      });
      req.on('error', reject);
      if (payload !== null) {
        req.write(payload);
      }
      req.end();
    });
  }
}

module.exports = {
  ClashFailover,
  NON_LEAF_PROXY_TYPES,
  parseClashSecret,
};
