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

// Hong Kong exits reset a large share of TLS handshakes to api.openai.com; keep
// them out of the automatic failover pool unless the operator opts back in.
const DEFAULT_EXCLUDE_NODE_REGEX = /香港|(?:^|[^a-z0-9])hk(?:[^a-z0-9]|$)|hong\s*kong|🇭🇰/iu;

const INFO_PROXY_PATTERNS = [
  /剩余流量|流量剩余|已用流量|总流量|套餐流量|可用流量|流量重置|流量已用|无限流量/,
  /距离下次重置|下次重置|重置剩余|重置/,
  /到期|过期时间|有效期|长期有效|永不过期/,
  /剩余\s*[:：]?\s*\d/,
  /官网|网址|官方地址|最新地址|备用地址|发布页|地址发布|防失联|主域名|备用域名/,
  /公告|客服|工单|优惠码|续费|请更新订阅|更新订阅|订阅转换|电报群|TG群|官方群|官方频道/i,
  /\b(?:website|telegram|channel|support|balance|traffic|remaining|expire[sd]?|expiration|reset)\s*[:：]/i,
  /https?:\/\//i,
  /\bt\.me\/[a-z0-9_]+/i,
  /\b20\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])\b/,
  /20\d{2}\s*年\s*(?:0?[1-9]|1[0-2])\s*月/,
  /^[^\p{L}\p{N}]*(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|top|xyz|cc|me|co|cn|vip|icu|shop|club|site|online|pw|link|click|buzz|fun|pro|app|dev|gg|tv|info|biz|uk|jp|kr|tw|hk|sg|us|de|fr|ru|la|ws|ai|so|ly|to|im|moe|cloud|tech|store|live|work|ltd|one)(?:\/[^\s]*)?[^\p{L}\p{N}]*$/iu,
];

const UPSTREAM_ALIGNMENT_NAME_RE =
  /(?:^|[^\p{L}])(?:steam|openai|chatgpt|ai)(?:[^\p{L}]|$)|漏网之鱼/iu;

function isInfoProxyName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    return false;
  }
  return INFO_PROXY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function isNonLeafMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return false;
  }
  const type = String(meta.type || '').toLowerCase();
  return NON_LEAF_PROXY_TYPES.has(type) || Array.isArray(meta.all);
}

function isRealLeafEntry(name, parentName, proxies) {
  if (!name || name === parentName || BUILTIN_NON_LEAF_NAMES.has(name) || isInfoProxyName(name)) {
    return false;
  }
  if (proxies && proxies[name]) {
    return !isNonLeafMeta(proxies[name]);
  }
  return true;
}

function isUsableSubgroupEntry(name, parentName, proxies) {
  if (!name || name === parentName || BUILTIN_NON_LEAF_NAMES.has(name) || isInfoProxyName(name)) {
    return false;
  }
  if (proxies && proxies[name]) {
    return isNonLeafMeta(proxies[name]);
  }
  return false;
}

function extractRuleStats(rules, selectorSet) {
  const ruleList = Array.isArray(rules) ? rules : Array.isArray(rules?.rules) ? rules.rules : [];
  let matchTarget = null;
  const ruleHits = new Map();

  for (const rule of ruleList) {
    if (!rule || typeof rule !== 'object') {
      continue;
    }
    const proxyName = String(rule.proxy || '').trim();
    if (proxyName && selectorSet.has(proxyName)) {
      ruleHits.set(proxyName, (ruleHits.get(proxyName) || 0) + 1);
      if (String(rule.type || '').toLowerCase() === 'match') {
        matchTarget = proxyName;
      }
    }
  }

  return { matchTarget, ruleHits };
}

function resolvePrimaryGroup(proxies, rules = null) {
  if (!proxies || typeof proxies !== 'object') {
    return null;
  }

  const selectorNames = Object.keys(proxies).filter((name) => {
    if (name === 'GLOBAL' || BUILTIN_NON_LEAF_NAMES.has(name)) {
      return false;
    }
    const meta = proxies[name];
    return Boolean(meta) && String(meta.type || '').toLowerCase() === 'selector' && Array.isArray(meta.all);
  });

  if (selectorNames.length === 0) {
    return null;
  }
  if (selectorNames.length === 1) {
    return selectorNames[0];
  }

  const selectorSet = new Set(selectorNames);
  const stats = new Map();

  for (const name of selectorNames) {
    const entries = proxies[name].all || [];
    let leafCount = 0;
    let usableSubgroupCount = 0;

    for (const entry of entries) {
      if (isRealLeafEntry(entry, name, proxies)) {
        leafCount += 1;
      } else if (isUsableSubgroupEntry(entry, name, proxies)) {
        usableSubgroupCount += 1;
      }
    }

    stats.set(name, {
      leafCount,
      usableSubgroupCount,
      inboundSelectorCount: 0,
    });
  }

  for (const sourceName of selectorNames) {
    const uniqueEntries = new Set(proxies[sourceName].all || []);
    for (const targetName of uniqueEntries) {
      if (targetName !== sourceName && selectorSet.has(targetName)) {
        stats.get(targetName).inboundSelectorCount += 1;
      }
    }
  }

  const { matchTarget, ruleHits } = extractRuleStats(rules, selectorSet);
  const leafSelectors = selectorNames.filter((name) => stats.get(name).leafCount > 0);

  if (leafSelectors.length === 1) {
    return leafSelectors[0];
  }

  if (leafSelectors.length > 1) {
    const leafSelectorSet = new Set(leafSelectors);
    const maxLeafCount = Math.max(...leafSelectors.map((name) => stats.get(name).leafCount));
    const fullPoolThreshold = Math.max(1, Math.ceil(maxLeafCount * 0.8));
    const isFullPool = (name) => (stats.get(name)?.leafCount || 0) >= fullPoolThreshold;

    const getChildLeafSelectors = (name) => {
      const entries = proxies[name]?.all || [];
      return entries.filter((entry) => entry !== name && leafSelectorSet.has(entry));
    };

    const getFullPoolChildrenCount = (name) => getChildLeafSelectors(name).filter(isFullPool).length;

    const rankLeafSelectors = (candidates) => {
      const ordered = [...candidates];
      ordered.sort((a, b) => {
        const fullDiff = Number(isFullPool(b)) - Number(isFullPool(a));
        if (fullDiff !== 0) return fullDiff;

        const inboundDiff = stats.get(b).inboundSelectorCount - stats.get(a).inboundSelectorCount;
        if (inboundDiff !== 0) return inboundDiff;

        const leafHubDiff =
          Number(getFullPoolChildrenCount(b) === 0) - Number(getFullPoolChildrenCount(a) === 0);
        if (leafHubDiff !== 0) return leafHubDiff;

        const matchDiff = Number(b === matchTarget) - Number(a === matchTarget);
        if (matchDiff !== 0) return matchDiff;

        const ruleHitDiff = (ruleHits.get(b) || 0) - (ruleHits.get(a) || 0);
        if (ruleHitDiff !== 0) return ruleHitDiff;

        return stats.get(b).leafCount - stats.get(a).leafCount;
      });
      return ordered[0] || null;
    };

    if (matchTarget) {
      const childLeafSelectors = getChildLeafSelectors(matchTarget);
      const fullPoolChildren = childLeafSelectors.filter(isFullPool);

      if (fullPoolChildren.length === 1) {
        return fullPoolChildren[0];
      }
      if (stats.get(matchTarget).leafCount === 0 && childLeafSelectors.length > 0) {
        return rankLeafSelectors(childLeafSelectors);
      }
      if (isFullPool(matchTarget) && fullPoolChildren.length === 0) {
        return matchTarget;
      }
    }

    return rankLeafSelectors(leafSelectors);
  }

  const usableSelectors = selectorNames.filter((name) => stats.get(name).usableSubgroupCount > 0);
  const pool = usableSelectors.length > 0 ? usableSelectors : selectorNames;
  if (matchTarget && pool.includes(matchTarget)) {
    return matchTarget;
  }

  const ordered = [...pool];
  ordered.sort((a, b) => {
    const inboundDiff = stats.get(b).inboundSelectorCount - stats.get(a).inboundSelectorCount;
    if (inboundDiff !== 0) return inboundDiff;

    const ruleHitDiff = (ruleHits.get(b) || 0) - (ruleHits.get(a) || 0);
    if (ruleHitDiff !== 0) return ruleHitDiff;

    return stats.get(b).usableSubgroupCount - stats.get(a).usableSubgroupCount;
  });
  return ordered[0] || null;
}

function parseClashSecret(content) {
  const match = String(content || '').match(/^secret:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m);
  return match ? match[1] ?? match[2] ?? match[3] ?? '' : '';
}

function parseNodeMultiplier(name) {
  const matched = String(name || '').match(
    /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*(?:[xX×]|倍)(?![a-zA-Z])/u
  );
  if (!matched) {
    return 1;
  }
  const value = Number(matched[1]);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function compileExcludePattern(pattern) {
  if (pattern instanceof RegExp) {
    return pattern;
  }
  if (typeof pattern === 'string' && pattern.trim()) {
    return new RegExp(pattern, 'iu');
  }
  return null;
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
    this.group = String(options.group || 'auto').trim() || 'auto';
    this.upstreamGroups = normalizeNameList(options.upstreamGroups, ['Steam', 'Final']);
    this.upstreamGroupsSet = new Set(this.upstreamGroups);
    this.candidates = Array.isArray(options.candidates) ? options.candidates.filter(Boolean) : [];
    this.excludeNodeRegex = compileExcludePattern(options.excludeNodePattern);
    this.preferLowMultiplier = Boolean(options.preferLowMultiplier);
    this.extraProbes = (Array.isArray(options.extraProbes) ? options.extraProbes : [])
      .map((probe) => ({
        name: String(probe?.name || '').trim(),
        url: String(probe?.url || '').trim(),
        expected: String(probe?.expected || '200-299').trim() || '200-299',
        attempts: Math.max(1, Number(probe?.attempts) || 1),
      }))
      .filter((probe) => probe.name && probe.url);
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
    this.resolvedGroup = null;
    this.resolvedGroupSource = null;
    this.lastFilteredInfoNodes = [];
    this.lastFilteredExcludedNodes = [];
    this.eligibleCandidateCount = null;
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
      resolvedGroup: this.enabled ? this.resolvedGroup : null,
      resolvedGroupSource: this.enabled ? this.resolvedGroupSource : null,
      upstreamGroups: this.enabled ? [...this.upstreamGroups] : [],
      dynamicCandidates: this.candidates.includes('*'),
      eligibleCandidateCount: this.enabled ? this.eligibleCandidateCount : null,
      filteredInfoNodes: this.enabled ? [...this.lastFilteredInfoNodes] : [],
      filteredExcludedNodes: this.enabled ? [...this.lastFilteredExcludedNodes] : [],
      preferLowMultiplier: this.enabled ? this.preferLowMultiplier : false,
      extraProbes: this.enabled ? this.extraProbes.map((probe) => probe.name) : [],
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
    if (!this.enabled) {
      return [];
    }

    try {
      const { groupName, group, proxies, rules, source } = await this.#fetchGroupAndProxies();
      if (this.currentSelection === null) {
        this.currentSelection = group?.now || null;
      }
      if (this.upstreamGroups.length === 0) {
        this.lastAlignedUpstreams = [];
        return [];
      }
      const aligned = await this.#alignUpstreamGroups(proxies, groupName, rules, source);
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
      const { groupName, group, proxies, rules, source } = await this.#fetchGroupAndProxies();
      const current = group?.now || null;
      const allowed = new Set(group?.all || []);
      this.currentSelection = current;

      const alignedUpstreams = await this.#alignUpstreamGroups(proxies, groupName, rules, source);
      this.lastAlignedUpstreams = alignedUpstreams;
      this.#consumePendingFailure(current, alignedUpstreams);
      this.#pruneExpiredFailures();

      const currentEligible = Boolean(current) && this.#isEligibleSelection(current, allowed, proxies, groupName);
      const currentFailed = Boolean(current) && this.failedSelections.has(current);
      const cmEnabled = this.#getActiveCmTestUrls().length > 0;
      const fullyHealthy = (probe) => (probe.cmVerified || !cmEnabled) && probe.extraVerified;
      let currentDegradedFallback = null;

      if (current) {
        this.triedSelections.add(current);
        if (!currentEligible) {
          this.logger.warn(`Clash 当前节点为非落地策略组、信息提示条目、排除节点或不在候选池: ${current}，准备迁移到真实代理节点`);
        } else if (currentFailed) {
          const failureInfo = this.failedSelections.get(current);
          this.logger.warn(
            `Clash 当前节点近期登录失败，跳过原地复用: ${current} (${failureInfo?.reason || 'login-failed'})`
          );
        } else {
          try {
            const probe = await this.#probeNode(current);
            if (fullyHealthy(probe)) {
              this.lastResult = {
                available: true,
                switched: false,
                at: new Date().toISOString(),
                reason,
                group: groupName,
                current,
                delay: probe.delay,
                cmVerified: probe.cmVerified,
                extraVerified: probe.extraVerified,
                alignedUpstreams,
              };
              return this.lastResult;
            }

            // Steam 可达但附加拨测（OpenAI/Matrix）失败，比仅过 Web API 更可用。
            const rank = probe.cmVerified || !cmEnabled ? 2 : 1;
            currentDegradedFallback = {
              candidate: current,
              delay: probe.delay,
              cmVerified: probe.cmVerified,
              cmError: probe.cmError,
              extraVerified: probe.extraVerified,
              extraError: probe.extraError,
              rank,
            };
            this.logger.warn(
              `Clash 当前节点未通过全部拨测，继续寻找更优节点: ${current}: ${
                probe.extraError || probe.cmError || 'Steam CM 或附加拨测不可达'
              }`
            );
          } catch (err) {
            this.logger.warn(`Clash 当前节点不可用: ${current}: ${err.message}`);
          }
        }
      }

      const { allEligible, freshCandidates, recycledCandidates } = this.#partitionCandidates(
        allowed,
        current,
        proxies,
        groupName
      );

      const freshPick = await this.#pickAndSwitchCandidate(freshCandidates, current, reason, {
        groupName,
        recoveryMode: true,
        alignedUpstreams,
      });
      if (freshPick) {
        return freshPick;
      }

      if (currentDegradedFallback && !currentFailed) {
        const degraded = currentDegradedFallback;
        this.logger.warn(
          `没有完全达标的其它节点，暂保留当前降级可用节点: ${current}`
        );
        this.lastResult = {
          available: true,
          switched: false,
          at: new Date().toISOString(),
          reason,
          group: groupName,
          current,
          delay: degraded.delay,
          cmVerified: degraded.cmVerified,
          extraVerified: degraded.extraVerified,
          ...(degraded.rank < 2 ? { cmFallback: true } : { extraFallback: true }),
          alignedUpstreams,
        };
        return this.lastResult;
      }

      const recycledPick = await this.#pickAndSwitchCandidate(recycledCandidates, current, reason, {
        groupName,
        recoveryMode: true,
        alignedUpstreams,
        clearFailedOnSelect: true,
      });
      if (recycledPick) {
        return recycledPick;
      }

      if (allEligible.length === 1 && current && currentEligible && currentFailed && !currentDegradedFallback) {
        try {
          const probe = await this.#probeNode(current);
          this.failedSelections.delete(current);
          this.lastResult = {
            available: true,
            switched: false,
            at: new Date().toISOString(),
            reason,
            group: groupName,
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
        group: groupName,
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
      const { groupName, group, proxies, rules, source } = await this.#fetchGroupAndProxies();
      const current = group?.now || null;
      const allowed = new Set(group?.all || []);
      this.currentSelection = current;

      const alignedUpstreams = await this.#alignUpstreamGroups(proxies, groupName, rules, source);
      this.lastAlignedUpstreams = alignedUpstreams;
      this.#consumePendingFailure(current, alignedUpstreams);
      this.#pruneExpiredFailures();

      if (current) {
        this.triedSelections.add(current);
      }

      const { freshCandidates, recycledCandidates } = this.#partitionCandidates(
        allowed,
        current,
        proxies,
        groupName
      );
      const orderedCandidates = [...freshCandidates, ...recycledCandidates];

      const picked = await this.#pickAndSwitchCandidate(orderedCandidates, current, reason, {
        groupName,
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
        group: groupName,
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
      groupName = this.resolvedGroup || this.group,
      recoveryMode = false,
      alignedUpstreams = [],
      clearFailedOnSelect = false,
    } = options;
    const cmEnabled = this.#getActiveCmTestUrls().length > 0;
    let webApiFallback = null;
    let steamOnlyFallback = null;

    for (const candidate of candidates) {
      this.triedSelections.add(candidate);
      try {
        const probe = await this.#probeNode(candidate);
        const steamHealthy = probe.cmVerified || !cmEnabled;

        if (steamHealthy && probe.extraVerified) {
          return await this.#switchToCandidate(candidate, current, reason, probe, {
            groupName,
            recoveryMode,
            alignedUpstreams,
            clearFailedOnSelect,
            cmFallback: false,
          });
        }

        if (steamHealthy) {
          if (!steamOnlyFallback) {
            steamOnlyFallback = { candidate, probe };
          }
          this.logger.warn(
            `Clash ${recoveryMode ? '恢复' : ''}候选节点 Steam 可达但附加拨测未通过，先跳过: ${candidate}: ${
              probe.extraError || '附加拨测不可达'
            }`
          );
          continue;
        }

        if (!webApiFallback) {
          webApiFallback = { candidate, probe };
        }
        this.logger.warn(
          `Clash ${recoveryMode ? '恢复' : ''}候选节点仅过 Web API 但 Steam CM 不可达，先跳过: ${candidate}: ${
            probe.cmError || 'CM 不可达'
          }`
        );
      } catch (err) {
        this.logger.warn(`Clash ${recoveryMode ? '恢复' : ''}候选节点不可用: ${candidate}: ${err.message}`);
      }
    }

    if (steamOnlyFallback) {
      this.logger.warn(
        `没有通过全部拨测的候选节点，安全降级选用 Steam 可达节点: ${steamOnlyFallback.candidate}: ${
          steamOnlyFallback.probe.extraError || '附加拨测不可达'
        }`
      );
      return await this.#switchToCandidate(
        steamOnlyFallback.candidate,
        current,
        reason,
        steamOnlyFallback.probe,
        {
          groupName,
          recoveryMode,
          alignedUpstreams,
          clearFailedOnSelect,
          extraFallback: true,
        }
      );
    }

    if (webApiFallback) {
      this.logger.warn(
        `所有候选节点 Steam CM 增强探测均未通过，安全降级选用首个 Web API 可达节点: ${webApiFallback.candidate}`
      );
      return await this.#switchToCandidate(webApiFallback.candidate, current, reason, webApiFallback.probe, {
        groupName,
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
      groupName = this.resolvedGroup || this.group,
      recoveryMode = false,
      alignedUpstreams = [],
      clearFailedOnSelect = false,
      cmFallback = false,
      extraFallback = false,
    } = options;

    await this.#request(`/proxies/${encodeURIComponent(groupName)}`, 'PUT', { name: candidate });
    this.currentSelection = candidate;
    if (clearFailedOnSelect) {
      this.failedSelections.delete(candidate);
    }

    const result = {
      switched: true,
      at: new Date().toISOString(),
      reason,
      group: groupName,
      from: current,
      to: candidate,
      delay: probe.delay,
      cmVerified: probe.cmVerified,
      extraVerified: probe.extraVerified,
      alignedUpstreams,
    };
    if (recoveryMode) {
      result.available = true;
    }
    if (cmFallback) {
      result.cmFallback = true;
    }
    if (extraFallback) {
      result.extraFallback = true;
    }

    this.lastResult = result;
    this.logger.warn(
      `Clash ${recoveryMode ? '恢复探测切换成功' : '节点故障转移成功'}: ${groupName} ${
        current || 'unknown'
      } -> ${candidate}, Steam ${probe.cmVerified ? 'CM' : 'WebAPI'} ${probe.delay}ms${
        probe.extraVerified ? '' : '，附加拨测降级'
      }`
    );
    return this.lastResult;
  }

  #isAutoGroup() {
    return this.group.toLowerCase() === 'auto';
  }

  #isExcludedNode(name) {
    return Boolean(this.excludeNodeRegex && this.excludeNodeRegex.test(String(name || '').trim()));
  }

  #countNonGlobalSelectors(proxies) {
    if (!proxies || typeof proxies !== 'object') {
      return 0;
    }
    return Object.keys(proxies).filter((name) => {
      if (name === 'GLOBAL' || BUILTIN_NON_LEAF_NAMES.has(name)) {
        return false;
      }
      const meta = proxies[name];
      return Boolean(meta) && String(meta.type || '').toLowerCase() === 'selector' && Array.isArray(meta.all);
    }).length;
  }

  async #fetchRulesSafe() {
    try {
      const response = await this.#request('/rules');
      return Array.isArray(response?.rules) ? response.rules : null;
    } catch {
      return null;
    }
  }

  #updateResolvedGroup(groupName, source, group, proxies) {
    if (this.resolvedGroup && this.resolvedGroup !== groupName) {
      this.logger.warn(`Clash 故障转移策略组已切换: ${this.resolvedGroup} -> ${groupName}，重置节点冷却状态`);
      this.resetCycle();
    }
    this.resolvedGroup = groupName;
    this.resolvedGroupSource = source;

    const entries = Array.isArray(group?.all) ? group.all : [];
    const allowed = new Set(entries);
    if (this.candidates.includes('*')) {
      this.lastFilteredInfoNodes = entries.filter((name) => {
        if (!name || name === groupName || name === this.group || this.upstreamGroupsSet.has(name)) {
          return false;
        }
        if (BUILTIN_NON_LEAF_NAMES.has(name)) {
          return false;
        }
        if (proxies && proxies[name] && isNonLeafMeta(proxies[name])) {
          return false;
        }
        return isInfoProxyName(name);
      });
    } else {
      this.lastFilteredInfoNodes = [];
    }

    this.lastFilteredExcludedNodes =
      this.candidates.includes('*') && this.excludeNodeRegex
        ? entries.filter(
            (name) => isRealLeafEntry(name, groupName, proxies) && this.#isExcludedNode(name)
          )
        : [];

    this.eligibleCandidateCount =
      entries.length > 0 ? this.#partitionCandidates(allowed, null, proxies, groupName).allEligible.length : 0;
  }

  async #fetchGroupAndProxies() {
    try {
      const response = await this.#request('/proxies');
      const proxies = response && typeof response.proxies === 'object' ? response.proxies : null;
      if (proxies) {
        if (this.#isAutoGroup()) {
          const rules = this.#countNonGlobalSelectors(proxies) > 1 ? await this.#fetchRulesSafe() : null;
          const groupName = resolvePrimaryGroup(proxies, rules);
          if (!groupName || !proxies[groupName]) {
            throw new Error('未能从 Clash /proxies 自动识别可用的主 Selector 策略组');
          }
          this.#updateResolvedGroup(groupName, 'auto', proxies[groupName], proxies);
          return { groupName, group: proxies[groupName], proxies, rules, source: 'auto' };
        }

        if (proxies[this.group]) {
          this.#updateResolvedGroup(this.group, 'configured', proxies[this.group], proxies);
          return {
            groupName: this.group,
            group: proxies[this.group],
            proxies,
            rules: null,
            source: 'configured',
          };
        }

        const rules = this.#countNonGlobalSelectors(proxies) > 1 ? await this.#fetchRulesSafe() : null;
        const fallbackGroup = resolvePrimaryGroup(proxies, rules);
        if (fallbackGroup && proxies[fallbackGroup]) {
          if (this.resolvedGroupSource !== 'fallback' || this.resolvedGroup !== fallbackGroup) {
            this.logger.warn(
              `Clash 配置策略组 "${this.group}" 不存在，自动回退到当前订阅主策略组: ${fallbackGroup}`
            );
          }
          this.#updateResolvedGroup(fallbackGroup, 'fallback', proxies[fallbackGroup], proxies);
          return {
            groupName: fallbackGroup,
            group: proxies[fallbackGroup],
            proxies,
            rules,
            source: 'fallback',
          };
        }
      }
    } catch (err) {
      if (this.#isAutoGroup() || !/HTTP 404\b/.test(err.message)) {
        throw err;
      }
    }

    if (this.#isAutoGroup()) {
      throw new Error('Clash /proxies 接口不可用，无法自动识别主策略组');
    }

    const group = await this.#request(`/proxies/${encodeURIComponent(this.group)}`);
    this.#updateResolvedGroup(this.group, 'configured', group, null);
    return { groupName: this.group, group, proxies: null, rules: null, source: 'configured' };
  }

  #getEffectiveUpstreamGroups(proxies, targetGroupName, rules, source) {
    const result = [...this.upstreamGroups];
    if (source !== 'auto' && source !== 'fallback') {
      return result;
    }

    const seen = new Set(result);
    if (proxies && typeof proxies === 'object') {
      const selectorSet = new Set(
        Object.keys(proxies).filter((name) => {
          if (name === 'GLOBAL' || BUILTIN_NON_LEAF_NAMES.has(name)) {
            return false;
          }
          const meta = proxies[name];
          return Boolean(meta) && String(meta.type || '').toLowerCase() === 'selector' && Array.isArray(meta.all);
        })
      );

      if (rules) {
        const { matchTarget } = extractRuleStats(rules, selectorSet);
        if (matchTarget && matchTarget !== targetGroupName && !seen.has(matchTarget)) {
          seen.add(matchTarget);
          result.push(matchTarget);
        }
      }

      for (const name of selectorSet) {
        if (name !== targetGroupName && !seen.has(name) && UPSTREAM_ALIGNMENT_NAME_RE.test(name)) {
          seen.add(name);
          result.push(name);
        }
      }
    }

    return result;
  }

  async #alignUpstreamGroups(proxies, targetGroupName, rules, source) {
    if (!proxies || this.upstreamGroups.length === 0) {
      return [];
    }

    const effectiveUpstreams = this.#getEffectiveUpstreamGroups(proxies, targetGroupName, rules, source);
    const aligned = [];
    for (const upstreamName of effectiveUpstreams) {
      const upstream = proxies[upstreamName];
      if (!upstream) {
        continue;
      }
      if (String(upstream.type || '').toLowerCase() !== 'selector') {
        continue;
      }
      if (!Array.isArray(upstream.all) || !upstream.all.includes(targetGroupName)) {
        continue;
      }
      if (upstream.now === targetGroupName) {
        continue;
      }

      const previous = upstream.now || null;
      await this.#request(`/proxies/${encodeURIComponent(upstreamName)}`, 'PUT', { name: targetGroupName });
      upstream.now = targetGroupName;
      aligned.push({
        group: upstreamName,
        from: previous,
        to: targetGroupName,
      });
      this.logger.warn(
        `Clash 上游策略组已偏离，自动对齐: ${upstreamName} ${previous || 'unknown'} -> ${targetGroupName}`
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

  #isEligibleSelection(name, allowed, proxies, activeGroup = this.resolvedGroup || this.group) {
    if (!name || !allowed.has(name)) {
      return false;
    }

    if (this.#isExplicitCandidate(name)) {
      return true;
    }

    if (!this.candidates.includes('*')) {
      return false;
    }

    if (name === activeGroup || name === this.group || this.upstreamGroupsSet.has(name)) {
      return false;
    }

    if (isInfoProxyName(name)) {
      return false;
    }

    if (this.#isExcludedNode(name)) {
      return false;
    }

    if (proxies && proxies[name]) {
      if (isNonLeafMeta(proxies[name])) {
        return false;
      }
      return true;
    }

    return !BUILTIN_NON_LEAF_NAMES.has(name);
  }

  #partitionCandidates(allowed, current, proxies, activeGroup = this.resolvedGroup || this.group) {
    const configured = this.candidates.filter((candidate) => candidate !== '*');
    const rawPool = this.candidates.includes('*') ? [...configured, ...allowed] : configured;
    const allEligible = Array.from(new Set(rawPool)).filter((candidate) =>
      this.#isEligibleSelection(candidate, allowed, proxies, activeGroup)
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

    if (this.preferLowMultiplier) {
      // Array.prototype.sort is stable, so equal multipliers keep the
      // subscription order while 1x nodes move ahead of 2.5x fallbacks.
      freshCandidates.sort((a, b) => parseNodeMultiplier(a) - parseNodeMultiplier(b));
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
    let cmVerified = false;
    let cmDelay = null;
    let cmUrl = null;
    let cmError = null;

    for (const url of cmUrls) {
      try {
        cmDelay = await this.#probeUrl(candidate, url, '200-499');
        cmVerified = true;
        cmUrl = url;
        cmError = null;
        break;
      } catch (err) {
        cmError = err;
      }
    }

    let extraVerified = true;
    let extraError = null;
    const extraDelays = {};
    for (const probeSpec of this.extraProbes) {
      try {
        const delays = [];
        for (let attempt = 0; attempt < probeSpec.attempts; attempt += 1) {
          delays.push(await this.#probeUrl(candidate, probeSpec.url, probeSpec.expected));
        }
        extraDelays[probeSpec.name] = delays;
      } catch (err) {
        extraVerified = false;
        extraError = `${probeSpec.name}: ${err.message}`;
        break;
      }
    }

    return {
      delay: cmVerified ? cmDelay : apiDelay,
      apiDelay,
      cmVerified,
      cmUrl,
      cmError: cmVerified ? null : cmError?.message || (cmUrls.length > 0 ? 'Steam CM 不可达' : null),
      extraVerified,
      extraError,
      extraDelays,
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
  DEFAULT_EXCLUDE_NODE_REGEX,
  isInfoProxyName,
  parseClashSecret,
  parseNodeMultiplier,
  compileExcludePattern,
  resolvePrimaryGroup,
};
