const fs = require('fs');
const http = require('http');
const https = require('https');

function parseClashSecret(content) {
  const match = String(content || '').match(/^secret:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m);
  return match ? match[1] ?? match[2] ?? match[3] ?? '' : '';
}

class ClashFailover {
  constructor(options = {}) {
    this.enabled = Boolean(options.enabled);
    this.controllerUrl = String(options.controllerUrl || 'http://127.0.0.1:9090').replace(/\/$/, '');
    this.secretFile = options.secretFile || '';
    this.group = options.group || 'E-IX';
    this.candidates = Array.isArray(options.candidates) ? options.candidates.filter(Boolean) : [];
    this.testUrl = options.testUrl || 'https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/?cellid=0';
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || 8000);
    this.logger = options.logger || console;
    this.triedSelections = new Set();
    this.inFlight = null;
    this.currentSelection = null;
    this.lastResult = null;
  }

  resetCycle() {
    this.triedSelections.clear();
  }

  snapshot() {
    return {
      enabled: this.enabled,
      group: this.enabled ? this.group : null,
      dynamicCandidates: this.candidates.includes('*'),
      currentSelection: this.currentSelection,
      triedSelections: Array.from(this.triedSelections),
      lastResult: this.lastResult,
    };
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
    this.resetCycle();
    try {
      const group = await this.#request(`/proxies/${encodeURIComponent(this.group)}`);
      const current = group?.now || null;
      const allowed = new Set(group?.all || []);
      this.currentSelection = current;

      if (current) {
        this.triedSelections.add(current);
        try {
          const delay = await this.#probe(current);
          this.lastResult = {
            available: true,
            switched: false,
            at: new Date().toISOString(),
            reason,
            current,
            delay,
          };
          return this.lastResult;
        } catch (err) {
          this.logger.warn(`Clash 当前节点不可用: ${current}: ${err.message}`);
        }
      }

      const candidates = this.#getCandidates(allowed, current);
      for (const candidate of candidates) {
        this.triedSelections.add(candidate);
        try {
          const delay = await this.#probe(candidate);
          await this.#request(`/proxies/${encodeURIComponent(this.group)}`, 'PUT', { name: candidate });
          this.currentSelection = candidate;
          this.lastResult = {
            available: true,
            switched: true,
            at: new Date().toISOString(),
            reason,
            from: current,
            to: candidate,
            delay,
          };
          this.logger.warn(
            `Clash 恢复探测切换成功: ${this.group} ${current || 'unknown'} -> ${candidate}, Steam CM ${delay}ms`
          );
          return this.lastResult;
        } catch (err) {
          this.logger.warn(`Clash 恢复候选节点不可用: ${candidate}: ${err.message}`);
        }
      }

      this.lastResult = {
        available: false,
        switched: false,
        at: new Date().toISOString(),
        reason,
        from: current,
        error: candidates.length === 0 ? '没有可用的候选节点' : '当前及候选节点均不可用',
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
      const group = await this.#request(`/proxies/${encodeURIComponent(this.group)}`);
      const current = group?.now || null;
      const allowed = new Set(group?.all || []);
      this.currentSelection = current;
      if (current) {
        this.triedSelections.add(current);
      }

      const candidates = this.#getCandidates(allowed, current);

      for (const candidate of candidates) {
        this.triedSelections.add(candidate);
        try {
          const delay = await this.#probe(candidate);

          await this.#request(`/proxies/${encodeURIComponent(this.group)}`, 'PUT', { name: candidate });
          this.currentSelection = candidate;
          this.lastResult = {
            switched: true,
            at: new Date().toISOString(),
            reason,
            from: current,
            to: candidate,
            delay,
          };
          this.logger.warn(
            `Clash 节点故障转移成功: ${this.group} ${current || 'unknown'} -> ${candidate}, Steam CM ${delay}ms`
          );
          return this.lastResult;
        } catch (err) {
          this.logger.warn(`Clash 候选节点不可用: ${candidate}: ${err.message}`);
        }
      }

      this.lastResult = {
        switched: false,
        at: new Date().toISOString(),
        reason,
        from: current,
        error: candidates.length === 0 ? '没有未尝试的候选节点' : '候选节点均不可用',
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

  async #probe(candidate) {
    const query = new URLSearchParams({
      timeout: String(this.timeoutMs),
      url: this.testUrl,
      expected: '200-299',
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

  #getCandidates(allowed, current) {
    const configured = this.candidates.filter((candidate) => candidate !== '*');
    const pool = this.candidates.includes('*') ? [...configured, ...allowed] : configured;
    return Array.from(new Set(pool)).filter(
      (candidate) => candidate !== current && allowed.has(candidate) && !this.triedSelections.has(candidate)
    );
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
  parseClashSecret,
};
