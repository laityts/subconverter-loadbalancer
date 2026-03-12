// Cloudflare Worker 主文件
// 订阅转换负载均衡系统（增强版）

// ---------- 工具函数：结构化日志 ----------
let requestIdCounter = 0;
function generateRequestId() {
  return `${Date.now()}-${(requestIdCounter++ % 1000).toString().padStart(3, '0')}`;
}

function log(level, message, data = null, reqId = null) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    requestId: reqId,
    ...(data && { data }),
  };
  console.log(JSON.stringify(logEntry));
}

function logDebug(message, data = null, reqId = null) {
  log('DEBUG', message, data, reqId);
}

function logInfo(message, data = null, reqId = null) {
  log('INFO', message, data, reqId);
}

function logError(message, error = null, reqId = null) {
  const errorData = error ? { error: error.message, stack: error.stack } : null;
  log('ERROR', message, errorData, reqId);
}

// ---------- 配置读取（从环境变量）----------
function getConfig(env) {
  return {
    INITIAL_WEIGHT: parseInt(env.INITIAL_WEIGHT) || 10,
    MAX_WEIGHT: parseInt(env.MAX_WEIGHT) || 20,
    MIN_WEIGHT: parseInt(env.MIN_WEIGHT) || 1,
    REQUEST_TIMEOUT: parseInt(env.REQUEST_TIMEOUT) || 10000,
    MAX_LOG_ENTRIES: parseInt(env.MAX_LOG_ENTRIES) || 20,
    CIRCUIT_BREAKER_THRESHOLD: parseInt(env.CIRCUIT_BREAKER_THRESHOLD) || 5,
    CIRCUIT_BREAKER_TIMEOUT: parseInt(env.CIRCUIT_BREAKER_TIMEOUT) || 300, // 秒
    HEALTH_CHECK_FAIL_THRESHOLD: parseInt(env.HEALTH_CHECK_FAIL_THRESHOLD) || 3,
    DEFAULT_BACKENDS: env.DEFAULT_BACKENDS ? JSON.parse(env.DEFAULT_BACKENDS) : [
      'https://url.v1.mk',
      'https://subapi.cmliussss.net',
      'https://subapi.sosoorg.com',
      'https://subapi.fxxk.dedyn.io',
      'https://subapi.zrfme.com'
    ],
  };
}

// ---------- 数据库表结构定义（新增复合索引）----------
const TABLE_SCHEMAS = {
  backend_servers: {
    columns: [
      { name: 'id', type: 'INTEGER PRIMARY KEY AUTOINCREMENT' },
      { name: 'url', type: 'TEXT NOT NULL UNIQUE' },
      { name: 'weight', type: 'INTEGER DEFAULT 10' },
      { name: 'dynamic_weight', type: 'REAL DEFAULT 10' },
      { name: 'total_requests', type: 'INTEGER DEFAULT 0' },
      { name: 'success_count', type: 'INTEGER DEFAULT 0' },
      { name: 'fail_count', type: 'INTEGER DEFAULT 0' },
      { name: 'average_response_time', type: 'REAL DEFAULT 0' },
      { name: 'last_response_time', type: 'REAL DEFAULT 0' },
      { name: 'ewma_success_rate', type: 'REAL DEFAULT 0.5' },
      { name: 'consecutive_failures', type: 'INTEGER DEFAULT 0' },
      { name: 'health_check_failures', type: 'INTEGER DEFAULT 0' },
      { name: 'disabled_until', type: 'TIMESTAMP' },
      { name: 'last_used', type: 'TIMESTAMP' },
      { name: 'enabled', type: 'BOOLEAN DEFAULT 1' },
      { name: 'healthy', type: 'BOOLEAN DEFAULT 1' },
      { name: 'last_health_check', type: 'TIMESTAMP' },
      { name: 'created_at', type: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' }
    ],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_backend_servers_weight ON backend_servers(dynamic_weight DESC)',
      'CREATE INDEX IF NOT EXISTS idx_backend_servers_enabled ON backend_servers(enabled, healthy, disabled_until)', // 复合索引
      'CREATE INDEX IF NOT EXISTS idx_backend_servers_disabled ON backend_servers(disabled_until)'
    ]
  },
  request_logs: {
    columns: [
      { name: 'id', type: 'INTEGER PRIMARY KEY AUTOINCREMENT' },
      { name: 'backend_url', type: 'TEXT NOT NULL' },
      { name: 'response_time', type: 'REAL NOT NULL' },
      { name: 'status', type: 'TEXT NOT NULL' },
      { name: 'error_message', type: 'TEXT' },
      { name: 'dynamic_weight', type: 'REAL' },
      { name: 'request_time', type: 'TIMESTAMP NOT NULL' },
      { name: 'created_at', type: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' }
    ],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_request_logs_time ON request_logs(request_time DESC)',
      'CREATE INDEX IF NOT EXISTS idx_request_logs_backend ON request_logs(backend_url)'
    ]
  }
};

// ---------- 数据库初始化/升级辅助函数 ----------
async function checkTableExists(env, tableName) {
  const result = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).bind(tableName).first();
  return result !== null;
}

async function getTableColumns(env, tableName) {
  try {
    const result = await env.DB.prepare(`PRAGMA table_info(${tableName})`).all();
    return result.results ? result.results.map(col => ({ name: col.name, type: col.type })) : [];
  } catch {
    return [];
  }
}

async function updateTableSchema(env, tableName) {
  if (!TABLE_SCHEMAS[tableName]) return false;
  const existingColumns = await getTableColumns(env, tableName);
  const existingNames = existingColumns.map(c => c.name.toLowerCase());
  const schemaColumns = TABLE_SCHEMAS[tableName].columns;
  for (const col of schemaColumns) {
    if (!existingNames.includes(col.name.toLowerCase())) {
      try {
        await env.DB.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${col.name} ${col.type}`).run();
        logInfo(`表 ${tableName} 添加列: ${col.name}`);
      } catch (e) {
        logError(`添加列 ${col.name} 失败`, e);
      }
    }
  }
  for (const idx of TABLE_SCHEMAS[tableName].indexes || []) {
    try { await env.DB.prepare(idx).run(); } catch (e) { logError(`创建索引失败`, e); }
  }
  return true;
}

async function ensureDatabaseInitialized(env) {
  const backendExists = await checkTableExists(env, 'backend_servers');
  const logsExists = await checkTableExists(env, 'request_logs');
  if (!backendExists || !logsExists) {
    await createDatabaseTables(env);
  } else {
    await updateTableSchema(env, 'backend_servers');
    await updateTableSchema(env, 'request_logs');
  }
  return true;
}

async function createDatabaseTables(env) {
  const backendCols = TABLE_SCHEMAS.backend_servers.columns.map(c => `${c.name} ${c.type}`).join(',\n');
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS backend_servers (${backendCols})`).run();
  const logsCols = TABLE_SCHEMAS.request_logs.columns.map(c => `${c.name} ${c.type}`).join(',\n');
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS request_logs (${logsCols})`).run();
  for (const idx of TABLE_SCHEMAS.backend_servers.indexes) await env.DB.prepare(idx).run();
  for (const idx of TABLE_SCHEMAS.request_logs.indexes) await env.DB.prepare(idx).run();
  logInfo('数据库表创建完成');
}

// ---------- 智能权重计算（基于 EWMA + 连续失败惩罚）----------
function computeDynamicWeight(baseWeight, ewma, avgResponseTime, consecutiveFailures, config) {
  const { INITIAL_WEIGHT, MAX_WEIGHT, MIN_WEIGHT } = config;
  const normRT = Math.max(0, 1 - Math.min(avgResponseTime / 3000, 1));
  const penalty = Math.exp(-consecutiveFailures);
  const factor = 0.6 * ewma + 0.2 * normRT + 0.2 * penalty;
  let weight = Math.round(baseWeight * factor);
  weight = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, weight));
  return weight;
}

// ---------- 被动健康检查触发 ----------
async function triggerPassiveHealthCheck(env, backendId, backendUrl, config, reqId) {
  try {
    logInfo(`触发被动健康检查: ${backendUrl}`, null, reqId);
    const testUrl = '/sub?target=clash&url=https://www.google.com';
    const start = Date.now();
    const res = await fetchWithTimeout(`${backendUrl}${testUrl}`, {}, config.REQUEST_TIMEOUT);
    const ok = res.ok;
    const responseTime = Date.now() - start;
    
    // 更新健康状态
    await env.DB.prepare(`
      UPDATE backend_servers 
      SET healthy = ?, last_health_check = datetime('now'),
          health_check_failures = ?
      WHERE id = ?
    `).bind(ok ? 1 : 0, ok ? 0 : 1, backendId).run();
    
    logInfo(`被动健康检查完成: ${backendUrl} ${ok ? '通过' : '失败'}`, { responseTime }, reqId);
  } catch (error) {
    logError(`被动健康检查失败: ${backendUrl}`, error, reqId);
    // 标记为不健康
    await env.DB.prepare(`
      UPDATE backend_servers 
      SET healthy = 0, last_health_check = datetime('now'),
          health_check_failures = health_check_failures + 1
      WHERE id = ?
    `).bind(backendId).run();
  }
}

// ---------- 更新后端统计（EWMA、连续失败、动态权重、熔断）----------
async function updateBackendStats(env, backendId, backendUrl, success, responseTime, config, reqId) {
  const startTime = Date.now();
  try {
    const record = await env.DB.prepare(`
      SELECT total_requests, success_count, fail_count, average_response_time,
             weight, ewma_success_rate, consecutive_failures, disabled_until
      FROM backend_servers WHERE id = ?
    `).bind(backendId).first();
    if (!record) return;

    const total = record.total_requests + 1;
    const successCount = record.success_count + (success ? 1 : 0);
    const failCount = record.fail_count + (success ? 0 : 1);

    let avgRT;
    if (record.total_requests === 0) avgRT = responseTime;
    else avgRT = (record.average_response_time * record.total_requests + responseTime) / total;

    const alpha = 0.3;
    const currentSuccess = success ? 1 : 0;
    const ewma = alpha * currentSuccess + (1 - alpha) * (record.ewma_success_rate || 0.5);

    // 连续失败计数
    let consecutiveFails = success ? 0 : (record.consecutive_failures || 0) + 1;

    // 熔断逻辑
    let disabledUntil = record.disabled_until;
    const now = new Date();
    if (!success && consecutiveFails >= config.CIRCUIT_BREAKER_THRESHOLD) {
      disabledUntil = new Date(now.getTime() + config.CIRCUIT_BREAKER_TIMEOUT * 1000).toISOString();
      logInfo(`后端 ${backendUrl} 触发熔断，禁用至 ${disabledUntil}`, { consecutiveFails, threshold: config.CIRCUIT_BREAKER_THRESHOLD }, reqId);
    }

    const baseWeight = record.weight || config.INITIAL_WEIGHT;
    const dynamicWeight = computeDynamicWeight(baseWeight, ewma, avgRT, consecutiveFails, config);

    await env.DB.prepare(`
      UPDATE backend_servers 
      SET total_requests = ?, success_count = ?, fail_count = ?,
          average_response_time = ?, last_response_time = ?,
          ewma_success_rate = ?, consecutive_failures = ?,
          dynamic_weight = ?, last_used = datetime('now'),
          disabled_until = ?
      WHERE id = ?
    `).bind(total, successCount, failCount, avgRT, responseTime,
            ewma, consecutiveFails, dynamicWeight, disabledUntil, backendId).run();

    const dbTime = Date.now() - startTime;
    logDebug(`后端统计更新完成`, { backendId, dbTime, dynamicWeight }, reqId);

    // 被动健康检查：如果连续失败达到阈值（如3次），触发主动探测
    if (!success && consecutiveFails >= 3) {
      // 异步触发健康检查，不等待
      triggerPassiveHealthCheck(env, backendId, backendUrl, config, reqId).catch(e => 
        logError('被动健康检查执行失败', e, reqId)
      );
    }
  } catch (error) {
    logError(`更新后端统计失败: id=${backendId}`, error, reqId);
  }
}

// ---------- 记录请求日志（异步，仅插入）----------
async function logRequest(env, data, reqId) {
  const startTime = Date.now();
  try {
    await env.DB.prepare(`
      INSERT INTO request_logs (backend_url, response_time, status, error_message, dynamic_weight, request_time)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(data.backend_url, data.response_time, data.status,
            data.error_message || '', data.dynamic_weight || 0, data.request_time).run();
    logDebug(`请求日志插入成功`, { dbTime: Date.now() - startTime }, reqId);
  } catch (error) {
    logError('记录请求日志失败', error, reqId);
  }
}

// ---------- 定时清理旧日志（独立任务）----------
async function cleanupOldLogs(env, config, reqId = 'cleanup') {
  const startTime = Date.now();
  try {
    const result = await env.DB.prepare(`
      DELETE FROM request_logs 
      WHERE id NOT IN (
        SELECT id FROM request_logs 
        ORDER BY request_time DESC 
        LIMIT ?
      )
    `).bind(config.MAX_LOG_ENTRIES).run();
    logInfo(`清理旧日志完成`, { dbTime: Date.now() - startTime, changes: result.meta?.changes }, reqId);
  } catch (error) {
    logError('清理旧日志失败', error, reqId);
  }
}

// ---------- 选择后端（基于动态权重加权随机，排除熔断中的后端）----------
async function selectBackend(env, config, excludeIds = [], reqId) {
  const startTime = Date.now();
  try {
    const now = new Date().toISOString();
    let query = `
      SELECT id, url, dynamic_weight 
      FROM backend_servers 
      WHERE enabled = 1 AND healthy = 1 
        AND (disabled_until IS NULL OR disabled_until < ?)
    `;
    const params = [now];
    if (excludeIds.length > 0) {
      query += ` AND id NOT IN (${excludeIds.map(() => '?').join(',')})`;
      params.push(...excludeIds);
    }
    const result = await env.DB.prepare(query).bind(...params).all();
    const backends = result.results || [];
    if (backends.length === 0) return null;

    let totalWeight = backends.reduce((sum, b) => sum + (b.dynamic_weight || config.INITIAL_WEIGHT), 0);
    let rand = Math.random() * totalWeight;
    for (const b of backends) {
      rand -= (b.dynamic_weight || config.INITIAL_WEIGHT);
      if (rand <= 0) {
        logDebug(`后端选择完成`, { backend: b.url, weight: b.dynamic_weight, dbTime: Date.now() - startTime }, reqId);
        return b;
      }
    }
    return backends[0];
  } catch (error) {
    logError('选择后端失败', error, reqId);
    return null;
  }
}

// ---------- 带超时的 fetch ----------
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// ---------- 处理订阅请求（含重试机制、熔断、结构化日志）----------
async function handleSubscriptionRequest(request, env, ctx) {
  const reqId = generateRequestId();
  const config = getConfig(env);
  const url = new URL(request.url);
  const maxRetries = 3;
  const triedIds = new Set();
  const totalStart = Date.now();

  logInfo('收到订阅请求', { method: request.method, path: url.pathname, query: url.search }, reqId);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const selectStart = Date.now();
    const backend = await selectBackend(env, config, Array.from(triedIds), reqId);
    if (!backend) {
      logError(`第${attempt}次尝试: 无可用后端`, null, reqId);
      break;
    }
    triedIds.add(backend.id);
    const selectTime = Date.now() - selectStart;

    const backendUrl = `${backend.url}${url.pathname}${url.search}`;
    const startTime = Date.now();
    let response, errorMsg, status, statusCode;

    try {
      // 精简请求头
      const headers = new Headers();
      const allowedHeaders = ['accept', 'accept-language', 'content-type', 'user-agent', 'authorization'];
      for (const [key, value] of request.headers.entries()) {
        if (allowedHeaders.includes(key.toLowerCase())) {
          headers.set(key, value);
        }
      }

      const forwardReq = new Request(backendUrl, {
        method: request.method,
        headers: headers,
        body: request.body,
        redirect: 'manual'
      });

      const fetchStart = Date.now();
      response = await fetchWithTimeout(forwardReq, {}, config.REQUEST_TIMEOUT);
      const fetchTime = Date.now() - fetchStart;
      const responseTime = Date.now() - startTime;
      statusCode = response.status;
      const isSuccess = response.ok;
      status = isSuccess ? 'success' : 'failed';
      errorMsg = isSuccess ? '' : `HTTP ${statusCode}`;

      // 异步记录日志和统计（并行执行）
      ctx.waitUntil((async () => {
        await Promise.all([
          logRequest(env, {
            backend_url: backend.url,
            response_time: responseTime,
            status: status,
            error_message: errorMsg,
            dynamic_weight: backend.dynamic_weight,
            request_time: new Date().toISOString()
          }, reqId),
          updateBackendStats(env, backend.id, backend.url, isSuccess, responseTime, config, reqId)
        ]);
      })());

      if (isSuccess) {
        const totalTime = Date.now() - totalStart;
        logInfo('请求成功', { 
          backend: backend.url, 
          attempt, 
          responseTime, 
          fetchTime,
          selectTime,
          totalTime,
          statusCode 
        }, reqId);
        
        const headers = new Headers(response.headers);
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Cache-Control', 'no-store');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      } else {
        if (statusCode >= 500 && statusCode < 600) {
          const delay = 100 * Math.pow(2, attempt - 1) + Math.random() * 50;
          logInfo(`后端 ${backend.url} 返回 ${statusCode}，等待 ${delay.toFixed(0)}ms 后重试 (${attempt}/${maxRetries})`, 
            { responseTime, fetchTime, selectTime }, reqId);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        } else {
          logInfo(`后端 ${backend.url} 返回不可重试错误 ${statusCode}，终止`, 
            { responseTime, fetchTime, selectTime }, reqId);
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: { 'Access-Control-Allow-Origin': '*' }
          });
        }
      }
    } catch (error) {
      const fetchTime = Date.now() - startTime;
      const responseTime = fetchTime;
      status = 'failed';
      errorMsg = error.name === 'AbortError' ? 'Timeout' : error.message;

      ctx.waitUntil((async () => {
        await Promise.all([
          logRequest(env, {
            backend_url: backend.url,
            response_time: responseTime,
            status: status,
            error_message: errorMsg,
            dynamic_weight: backend.dynamic_weight,
            request_time: new Date().toISOString()
          }, reqId),
          updateBackendStats(env, backend.id, backend.url, false, responseTime, config, reqId)
        ]);
      })());

      if (attempt < maxRetries) {
        const delay = 100 * Math.pow(2, attempt - 1) + Math.random() * 50;
        logInfo(`后端 ${backend.url} 请求异常 (${errorMsg})，等待 ${delay.toFixed(0)}ms 后重试 (${attempt}/${maxRetries})`, 
          { responseTime, fetchTime, selectTime }, reqId);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      } else {
        logError(`后端 ${backend.url} 最终失败`, error, reqId);
      }
    }
  }

  const totalTime = Date.now() - totalStart;
  logError('所有重试失败', { totalTime, attempts: maxRetries }, reqId);
  return new Response(JSON.stringify({ error: 'All backends failed', attempts: maxRetries }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

// ---------- 处理版本请求（简化版）----------
async function handleVersionRequest(request, env, ctx) {
  const reqId = generateRequestId();
  const config = getConfig(env);
  const maxRetries = 2;
  const triedIds = new Set();
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const backend = await selectBackend(env, config, Array.from(triedIds), reqId);
    if (!backend) break;
    triedIds.add(backend.id);
    try {
      const versionUrl = `${backend.url}/version`;
      const res = await fetchWithTimeout(versionUrl, {}, config.REQUEST_TIMEOUT);
      if (res.ok) {
        const text = await res.text();
        return new Response(text, {
          headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }
        });
      }
    } catch (e) {
      logError(`版本请求失败 ${backend.url}`, e, reqId);
    }
  }
  return new Response('Version check failed', { status: 503 });
}

// ---------- 主动健康检查（定时任务，每30分钟）----------
async function scheduledHealthCheck(env, config, ctx) {
  const reqId = 'healthcheck';
  logInfo('开始执行健康检查', null, reqId);
  try {
    const backends = await env.DB.prepare(`SELECT id, url, health_check_failures FROM backend_servers WHERE enabled = 1`).all();
    if (!backends.results) return;

    const testUrl = '/sub?target=clash&url=https://www.google.com';
    for (const backend of backends.results) {
      try {
        const start = Date.now();
        const res = await fetchWithTimeout(`${backend.url}${testUrl}`, {}, config.REQUEST_TIMEOUT);
        const ok = res.ok;
        const responseTime = Date.now() - start;
        let healthFailures = backend.health_check_failures || 0;
        if (!ok) {
          healthFailures += 1;
        } else {
          healthFailures = 0;
        }
        const healthy = healthFailures < config.HEALTH_CHECK_FAIL_THRESHOLD;
        await env.DB.prepare(`
          UPDATE backend_servers 
          SET healthy = ?, last_health_check = datetime('now'),
              health_check_failures = ?
          WHERE id = ?
        `).bind(healthy ? 1 : 0, healthFailures, backend.id).run();
        logDebug(`健康检查 ${backend.url}: ${ok ? '通过' : '失败'} (连续失败 ${healthFailures})`, 
          { responseTime }, reqId);
      } catch (e) {
        let healthFailures = (backend.health_check_failures || 0) + 1;
        const healthy = healthFailures < config.HEALTH_CHECK_FAIL_THRESHOLD;
        await env.DB.prepare(`
          UPDATE backend_servers 
          SET healthy = ?, last_health_check = datetime('now'),
              health_check_failures = ?
          WHERE id = ?
        `).bind(healthy ? 1 : 0, healthFailures, backend.id).run();
        logError(`健康检查异常 ${backend.url}`, e, reqId);
      }
    }
  } catch (error) {
    logError('健康检查整体失败', error, reqId);
  }
}

// ---------- 定时任务入口 ----------
async function scheduled(event, env, ctx) {
  const config = getConfig(env);
  const type = event.cron;
  if (type === '*/30 * * * *') {
    await scheduledHealthCheck(env, config, ctx);
  } else if (type === '0 * * * *') {
    await cleanupOldLogs(env, config, 'cron');
  }
}

// ---------- API 处理函数 ----------
async function handleBackendStats(request, env) {
  const reqId = generateRequestId();
  try {
    const result = await env.DB.prepare(`
      SELECT id, url, weight, dynamic_weight, total_requests, success_count, fail_count,
             average_response_time, last_response_time, ewma_success_rate, consecutive_failures,
             health_check_failures, disabled_until, last_used, enabled, healthy, last_health_check, created_at
      FROM backend_servers ORDER BY dynamic_weight DESC
    `).all();
    return new Response(JSON.stringify(result.results || []), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
    });
  } catch (error) {
    logError('获取后端统计失败', error, reqId);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleRecentRequests(request, env) {
  const reqId = generateRequestId();
  try {
    const result = await env.DB.prepare(`
      SELECT id, backend_url, response_time, status, error_message, dynamic_weight, request_time
      FROM request_logs ORDER BY request_time DESC LIMIT 20
    `).all();
    return new Response(JSON.stringify(result.results || []), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
    });
  } catch (error) {
    logError('获取最近请求失败', error, reqId);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleInitDatabase(request, env) {
  const reqId = generateRequestId();
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const config = getConfig(env);
  try {
    await ensureDatabaseInitialized(env);
    await env.DB.prepare('DELETE FROM backend_servers').run();
    await env.DB.prepare('DELETE FROM request_logs').run();

    let inserted = 0, errors = [];
    for (const url of config.DEFAULT_BACKENDS) {
      try {
        await env.DB.prepare(`
          INSERT INTO backend_servers (url, weight, dynamic_weight, ewma_success_rate, healthy, health_check_failures)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(url, config.INITIAL_WEIGHT, config.INITIAL_WEIGHT, 0.5, 1, 0).run();
        inserted++;
      } catch (e) {
        errors.push({ url, error: e.message });
      }
    }
    logInfo('数据库初始化完成', { inserted, errors }, reqId);
    return new Response(JSON.stringify({ success: true, backends_added: inserted, errors }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (error) {
    logError('数据库初始化失败', error, reqId);
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

// ---------- 页面处理：状态页面（已适配移动端卡片和地址换行）----------
async function handleStatusPage(request, env) {
  const config = getConfig(env);
  const reqId = generateRequestId();
  const [backendStats, recentRequests] = await Promise.allSettled([
    env.DB.prepare(`
      SELECT id, url, weight, dynamic_weight, total_requests, success_count, fail_count,
             average_response_time, last_response_time, ewma_success_rate, consecutive_failures,
             health_check_failures, disabled_until, last_used, enabled, healthy, last_health_check
      FROM backend_servers ORDER BY dynamic_weight DESC LIMIT 10
    `).all(),
    env.DB.prepare(`
      SELECT backend_url, response_time, status, error_message, dynamic_weight, request_time
      FROM request_logs ORDER BY request_time DESC LIMIT 20
    `).all()
  ]);

  const backends = backendStats.value?.results || [];
  const requests = recentRequests.value?.results || [];

  // 构造后端表格行（用于桌面端）和卡片数据（移动端）
  const backendRows = backends.map(b => {
    const total = b.total_requests || 0;
    const success = b.success_count || 0;
    const fail = b.fail_count || 0;
    const rate = total > 0 ? ((success / total) * 100).toFixed(1) : '0.0';
    const avgRT = b.average_response_time || 0;
    const ewma = (b.ewma_success_rate || 0.5).toFixed(3);
    const consecFails = b.consecutive_failures || 0;
    const healthy = b.healthy === 1;
    const disabledUntil = b.disabled_until ? new Date(b.disabled_until).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : null;
    const dynamicWeight = b.dynamic_weight || b.weight || config.INITIAL_WEIGHT;

    return `<tr>
      <td data-label="后端地址">
        <div class="mobile-row"><strong>${b.url || '未知'}</strong></div>
        <div style="display:flex; flex-wrap:wrap; gap:6px;">
          <span class="healthy-badge ${healthy ? 'healthy-true' : 'healthy-false'}">${healthy ? '健康' : '不健康'}</span>
          ${b.enabled === 0 ? '<span class="status-badge status-failed">已禁用</span>' : ''}
          ${disabledUntil ? `<span class="status-badge status-failed">熔断至 ${disabledUntil}</span>` : ''}
        </div>
        <div style="max-width:200px; overflow:hidden; text-overflow:ellipsis; word-break:break-all;">${b.url || '未知'}</div>
      </td>
      <td data-label="请求统计">
        <div><small>总请求: ${total}</small></div>
        <div><small>成功: ${success} | 失败: ${fail}</small></div>
        <div><small>成功率: ${rate}%</small></div>
        <div class="progress-container"><div class="progress-bar" style="width:${Math.min(rate, 100)}%"></div></div>
      </td>
      <td data-label="性能指标">
        <div><small>平均响应: ${formatResponseTimeForHTML(avgRT)}</small></div>
        <div><small>最后响应: ${formatResponseTimeForHTML(b.last_response_time || 0)}</small></div>
        <div><small>EWMA成功率: ${ewma}</small></div>
        <div><small>连续失败: ${consecFails}</small></div>
      </td>
      <td data-label="权重状态">
        <div><small>基础权重: ${b.weight || config.INITIAL_WEIGHT}</small></div>
        <div><small>动态权重: ${dynamicWeight.toFixed(1)}</small></div>
        <div><small>最后使用: ${b.last_used ? formatBeijingTimeForHTML(b.last_used) : '从未'}</small></div>
        <div><small>最后健康检查: ${b.last_health_check ? formatBeijingTimeForHTML(b.last_health_check) : '从未'}</small></div>
      </td>
    </tr>`;
  }).join('');

  const requestRows = requests.map(r => {
    const statusClass = r.status === 'success' ? 'status-success' : 'status-failed';
    const statusText = r.status === 'success' ? '成功' : '失败';
    const weight = r.dynamic_weight || 0;
    const weightLevel = weight >= 15 ? '高' : weight >= 10 ? '中' : '低';
    return `<tr>
      <td data-label="后端地址">
        <div class="mobile-row"><strong>${r.backend_url || '未知'}</strong></div>
        <div style="max-width:180px; overflow:hidden; text-overflow:ellipsis; word-break:break-all;">${r.backend_url || '未知'}</div>
      </td>
      <td data-label="状态">
        <span class="status-badge ${statusClass}">${statusText}</span>
        ${r.error_message ? `<div><small style="color:#718096;font-size:11px;">${r.error_message.substring(0,40)}${r.error_message.length>40?'...':''}</small></div>` : ''}
      </td>
      <td data-label="动态权重">
        <div class="weight-info">
          <span class="weight-badge" title="请求时的动态权重">${weight.toFixed(1)}</span>
          <div class="weight-label">${weightLevel}权重</div>
        </div>
      </td>
      <td data-label="响应时间">${formatResponseTimeForHTML(r.response_time || 0)}</td>
      <td data-label="请求时间">${formatBeijingTimeForHTML(r.request_time || new Date().toISOString())}</td>
    </tr>`;
  }).join('');

  // 移动端卡片 HTML
  const backendCards = backends.map(b => {
    const total = b.total_requests || 0;
    const success = b.success_count || 0;
    const fail = b.fail_count || 0;
    const rate = total > 0 ? ((success / total) * 100).toFixed(1) : '0.0';
    const avgRT = b.average_response_time || 0;
    const ewma = (b.ewma_success_rate || 0.5).toFixed(3);
    const consecFails = b.consecutive_failures || 0;
    const healthy = b.healthy === 1;
    const disabledUntil = b.disabled_until ? new Date(b.disabled_until).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : null;
    const dynamicWeight = b.dynamic_weight || b.weight || config.INITIAL_WEIGHT;

    return `<div class="mobile-card">
      <div class="mobile-card-header">
        <strong style="word-break:break-all;">${b.url || '未知'}</strong>
        <span class="healthy-badge ${healthy ? 'healthy-true' : 'healthy-false'}">${healthy ? '健康' : '不健康'}</span>
      </div>
      <div class="mobile-card-body">
        <div><span>总请求:</span> ${total}</div>
        <div><span>成功/失败:</span> ${success}/${fail}</div>
        <div><span>成功率:</span> ${rate}% <span class="progress-container" style="width:60px; display:inline-block; margin-left:8px;"><div class="progress-bar" style="width:${Math.min(rate,100)}%"></div></span></div>
        <div><span>平均响应:</span> ${formatResponseTimeForHTML(avgRT)}</div>
        <div><span>动态权重:</span> ${dynamicWeight.toFixed(1)} (基础: ${b.weight || config.INITIAL_WEIGHT})</div>
        <div><span>EWMA成功率:</span> ${ewma}</div>
        <div><span>连续失败:</span> ${consecFails}</div>
        <div><span>最后使用:</span> ${b.last_used ? formatBeijingTimeForHTML(b.last_used) : '从未'}</div>
        ${disabledUntil ? `<div><span>熔断至:</span> ${disabledUntil}</div>` : ''}
        <div><span>健康检查:</span> ${b.last_health_check ? formatBeijingTimeForHTML(b.last_health_check) : '从未'}</div>
      </div>
    </div>`;
  }).join('');

  const requestCards = requests.map(r => {
    const statusClass = r.status === 'success' ? 'status-success' : 'status-failed';
    const statusText = r.status === 'success' ? '成功' : '失败';
    const weight = r.dynamic_weight || 0;
    const weightLevel = weight >= 15 ? '高' : weight >= 10 ? '中' : '低';
    return `<div class="mobile-card">
      <div class="mobile-card-header">
        <strong style="word-break:break-all;">${r.backend_url || '未知'}</strong>
        <span class="status-badge ${statusClass}">${statusText}</span>
      </div>
      <div class="mobile-card-body">
        <div><span>动态权重:</span> ${weight.toFixed(1)} (${weightLevel})</div>
        <div><span>响应时间:</span> ${formatResponseTimeForHTML(r.response_time || 0)}</div>
        <div><span>请求时间:</span> ${formatBeijingTimeForHTML(r.request_time || new Date().toISOString())}</div>
        ${r.error_message ? `<div><span>错误:</span> ${r.error_message.substring(0,40)}${r.error_message.length>40?'...':''}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>订阅转换负载均衡 - 状态监控</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      --secondary-gradient: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      --success-gradient: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
      --card-bg: rgba(255, 255, 255, 0.95);
      --text-primary: #2d3748;
      --text-secondary: #718096;
      --border-color: #e2e8f0;
      --shadow-sm: 0 1px 3px rgba(0,0,0,0.1);
      --shadow-md: 0 4px 6px rgba(0,0,0,0.1);
      --shadow-lg: 0 10px 25px rgba(0,0,0,0.1);
      --radius-md: 12px;
      --radius-lg: 16px;
      --weight-gradient: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);
      --healthy-badge-bg: #c6f6d5;
      --healthy-badge-text: #22543d;
      --unhealthy-badge-bg: #fed7d7;
      --unhealthy-badge-text: #742a2a;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', sans-serif;
      background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
      min-height: 100vh;
      color: var(--text-primary);
      line-height: 1.6;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    .header {
      background: var(--card-bg);
      border-radius: var(--radius-lg);
      padding: 30px;
      margin-bottom: 30px;
      box-shadow: var(--shadow-lg);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.2);
    }
    .header-content {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 20px;
    }
    .title-section h1 {
      font-size: 28px;
      font-weight: 700;
      background: var(--primary-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 8px;
    }
    .title-section p { color: var(--text-secondary); font-size: 16px; }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      background: var(--success-gradient);
      color: white;
      border-radius: 20px;
      font-size: 14px;
      font-weight: 600;
      margin-left: 10px;
    }
    .action-buttons { display: flex; gap: 12px; flex-wrap: wrap; }
    .btn {
      padding: 12px 24px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      text-decoration: none;
    }
    .btn-primary {
      background: var(--primary-gradient);
      color: white;
    }
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
    }
    .btn-secondary {
      background: white;
      color: var(--text-primary);
      border: 1px solid var(--border-color);
    }
    .btn-secondary:hover {
      background: #f7fafc;
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
      gap: 25px;
      margin-bottom: 30px;
    }
    @media (max-width: 768px) {
      .stats-grid { grid-template-columns: 1fr; }
    }
    .card {
      background: var(--card-bg);
      border-radius: var(--radius-lg);
      padding: 30px;
      box-shadow: var(--shadow-lg);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.2);
      transition: transform 0.3s ease;
    }
    .card:hover { transform: translateY(-5px); }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 25px;
      padding-bottom: 15px;
      border-bottom: 2px solid #f7fafc;
    }
    .card-header h2 {
      font-size: 20px;
      font-weight: 600;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .card-header .icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
    }
    .card-header .server-icon {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .card-header .history-icon {
      background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
      color: white;
    }
    /* 桌面端表格样式 */
    .stats-table-container {
      overflow-x: auto;
      border-radius: 10px;
      background: white;
      box-shadow: var(--shadow-sm);
    }
    .stats-table {
      width: 100%;
      border-collapse: collapse;
      min-width: 800px;
    }
    .stats-table thead {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .stats-table th {
      padding: 16px 20px;
      text-align: left;
      color: white;
      font-weight: 600;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .stats-table th:first-child { border-top-left-radius: 10px; }
    .stats-table th:last-child { border-top-right-radius: 10px; }
    .stats-table tbody tr {
      border-bottom: 1px solid var(--border-color);
      transition: background 0.2s ease;
    }
    .stats-table tbody tr:hover { background: #f8fafc; }
    .stats-table tbody tr:last-child { border-bottom: none; }
    .stats-table td {
      padding: 18px 20px;
      color: var(--text-primary);
    }
    /* 移动端卡片样式 */
    .mobile-cards {
      display: none;
      flex-direction: column;
      gap: 15px;
    }
    .mobile-card {
      background: white;
      border-radius: 12px;
      padding: 15px;
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border-color);
    }
    .mobile-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px dashed var(--border-color);
    }
    .mobile-card-body {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px 12px;
      font-size: 13px;
    }
    .mobile-card-body div {
      display: flex;
      flex-wrap: wrap;
    }
    .mobile-card-body div span:first-child {
      color: var(--text-secondary);
      min-width: 70px;
    }
    @media (max-width: 768px) {
      .stats-table-container { display: none; }
      .mobile-cards { display: flex; }
    }
    .status-badge {
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      display: inline-block;
      min-width: 60px;
      text-align: center;
    }
    .status-success {
      background: linear-gradient(135deg, #c6f6d5 0%, #9ae6b4 100%);
      color: #22543d;
    }
    .status-failed {
      background: linear-gradient(135deg, #fed7d7 0%, #feb2b2 100%);
      color: #742a2a;
    }
    .healthy-badge {
      padding: 4px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      display: inline-block;
    }
    .healthy-true {
      background: var(--healthy-badge-bg);
      color: var(--healthy-badge-text);
    }
    .healthy-false {
      background: var(--unhealthy-badge-bg);
      color: var(--unhealthy-badge-text);
    }
    .weight-badge {
      display: inline-block;
      padding: 6px 12px;
      background: var(--weight-gradient);
      color: #22543d;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 700;
      text-align: center;
      min-width: 60px;
      box-shadow: 0 2px 4px rgba(67,233,123,0.3);
      transition: transform 0.2s ease;
    }
    .weight-badge:hover { transform: scale(1.05); }
    .weight-info {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .weight-label {
      font-size: 12px;
      color: var(--text-secondary);
      white-space: nowrap;
    }
    .progress-container {
      background: #e2e8f0;
      border-radius: 10px;
      height: 8px;
      overflow: hidden;
      margin-top: 8px;
    }
    .progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #4fd1c5 0%, #38b2ac 100%);
      border-radius: 10px;
      transition: width 0.5s ease;
    }
    .loading-state {
      text-align: center;
      padding: 60px 20px;
    }
    .loading-spinner {
      width: 50px;
      height: 50px;
      border: 3px solid #e2e8f0;
      border-top-color: #667eea;
      border-radius: 50%;
      margin: 0 auto 20px;
      animation: spin 1s linear infinite;
    }
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-secondary);
    }
    .empty-state i {
      font-size: 48px;
      margin-bottom: 20px;
      color: #cbd5e0;
    }
    .error-state {
      text-align: center;
      padding: 40px 20px;
      background: linear-gradient(135deg, #fed7d7 0%, #feb2b2 100%);
      border-radius: 10px;
      color: #742a2a;
    }
    .debug-panel {
      background: #1a202c;
      color: #e2e8f0;
      border-radius: 10px;
      padding: 20px;
      margin-top: 20px;
      font-family: 'Monaco', 'Courier New', monospace;
      font-size: 12px;
      max-height: 300px;
      overflow-y: auto;
    }
    .debug-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }
    .debug-header h4 { color: #81e6d9; }
    .debug-log {
      padding: 8px 0;
      border-bottom: 1px solid #2d3748;
    }
    .debug-log:last-child { border-bottom: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .fade-in { animation: fadeIn 0.5s ease-out; }
    @media (prefers-color-scheme: dark) {
      :root {
        --card-bg: rgba(45,55,72,0.95);
        --text-primary: #f7fafc;
        --text-secondary: #a0aec0;
        --border-color: #4a5568;
      }
      body { background: linear-gradient(135deg, #1a202c 0%, #2d3748 100%); }
      .card { border: 1px solid rgba(255,255,255,0.1); }
      .stats-table-container { background: #2d3748; }
      .stats-table tbody tr:hover { background: #4a5568; }
      .mobile-card { background: #2d3748; }
      .progress-container { background: #4a5568; }
      .weight-badge {
        background: linear-gradient(135deg, #2d3748 0%, #4a5568 100%);
        color: #81e6d9;
        border: 1px solid #38a169;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header fade-in">
      <div class="header-content">
        <div class="title-section">
          <h1><i class="fas fa-balance-scale"></i> 订阅转换负载均衡系统</h1>
          <p>基于 EWMA 成功率、响应时间和连续失败次数的智能加权轮询 | 实时监控</p>
        </div>
        <div class="action-buttons">
          <button class="btn btn-primary" onclick="refreshData()"><i class="fas fa-sync-alt"></i> 刷新数据</button>
          <button class="btn btn-secondary" onclick="location.href='/init'"><i class="fas fa-cog"></i> 系统设置</button>
          <button class="btn btn-secondary" onclick="toggleDebug()"><i class="fas fa-terminal"></i> 调试模式</button>
        </div>
      </div>
      <div id="debug-panel" class="debug-panel" style="display: none;">
        <div class="debug-header">
          <h4><i class="fas fa-bug"></i> 系统调试信息</h4>
          <button class="btn btn-secondary" onclick="clearDebugLogs()" style="padding:4px 8px;font-size:11px;">清空日志</button>
        </div>
        <div id="debug-content"></div>
      </div>
    </div>

    <div class="stats-grid">
      <!-- 后端服务器状态卡片 -->
      <div class="card fade-in" style="animation-delay:0.1s;">
        <div class="card-header">
          <h2><span class="icon server-icon"><i class="fas fa-server"></i></span> 后端服务器状态</h2>
          <div><span style="color:var(--text-secondary);font-size:14px;">总计: <span id="total-backends">${backends.length}</span> 个</span></div>
        </div>
        <div id="backend-stats-container">
          ${backends.length > 0 ? `
            <!-- 桌面端表格 -->
            <div class="stats-table-container">
              <table class="stats-table">
                <thead>
                  <tr>
                    <th>后端地址 / 健康</th>
                    <th>请求统计</th>
                    <th>性能指标</th>
                    <th>权重状态</th>
                  </tr>
                </thead>
                <tbody id="backend-stats-body">
                  ${backendRows}
                </tbody>
              </table>
            </div>
            <!-- 移动端卡片 -->
            <div class="mobile-cards" id="backend-mobile-cards">
              ${backendCards}
            </div>
          ` : `
            <div class="loading-state" id="backend-stats-loading">
              <div class="loading-spinner"></div>
              <p>正在加载后端服务器数据...</p>
            </div>
          `}
        </div>
      </div>

      <!-- 最近请求记录卡片 -->
      <div class="card fade-in" style="animation-delay:0.2s;">
        <div class="card-header">
          <h2><span class="icon history-icon"><i class="fas fa-history"></i></span> 最近请求记录</h2>
          <div><span style="color:var(--text-secondary);font-size:14px;">最近 ${config.MAX_LOG_ENTRIES} 条记录</span></div>
        </div>
        <div id="recent-requests-container">
          ${requests.length > 0 ? `
            <!-- 桌面端表格 -->
            <div class="stats-table-container">
              <table class="stats-table">
                <thead>
                  <tr>
                    <th>后端地址</th>
                    <th>状态</th>
                    <th>动态权重</th>
                    <th>响应时间</th>
                    <th>请求时间</th>
                  </tr>
                </thead>
                <tbody>
                  ${requestRows}
                </tbody>
              </table>
            </div>
            <!-- 移动端卡片 -->
            <div class="mobile-cards" id="recent-mobile-cards">
              ${requestCards}
            </div>
          ` : `
            <div class="loading-state" id="recent-requests-loading">
              <div class="loading-spinner"></div>
              <p>正在加载请求记录...</p>
            </div>
          `}
        </div>
      </div>
    </div>

    <!-- 系统信息卡片 -->
    <div class="card fade-in" style="animation-delay:0.3s; margin-top:25px;">
      <div class="card-header">
        <h2><span class="icon" style="background:linear-gradient(135deg,#f093fb 0%,#f5576c 100%); color:white;"><i class="fas fa-info-circle"></i></span> 系统信息</h2>
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px,1fr)); gap:20px;">
        <div>
          <h3 style="color:var(--text-secondary); font-size:14px; margin-bottom:8px;">权重算法</h3>
          <p style="font-size:16px; font-weight:500;">综合 EWMA 成功率、响应时间、连续失败次数</p>
          <p style="font-size:13px; color:var(--text-secondary);">范围: ${config.MIN_WEIGHT} - ${config.MAX_WEIGHT}</p>
        </div>
        <div>
          <h3 style="color:var(--text-secondary); font-size:14px; margin-bottom:8px;">最近活动</h3>
          <p style="font-size:16px; font-weight:500;" id="last-update-time">${formatBeijingTimeForHTML(new Date().toISOString())}</p>
          <p style="font-size:13px; color:var(--text-secondary);">每120秒自动刷新</p>
        </div>
        <div>
          <h3 style="color:var(--text-secondary); font-size:14px; margin-bottom:8px;">数据统计</h3>
          <p style="font-size:16px; font-weight:500;">保留最近 <strong>${config.MAX_LOG_ENTRIES}</strong> 条日志</p>
          <p style="font-size:13px; color:var(--text-secondary);">超时时间: ${config.REQUEST_TIMEOUT}ms</p>
        </div>
      </div>
    </div>
  </div>

  <script>
    // 工具函数
    function formatBeijingTime(isoString) {
      if (!isoString) return '从未';
      try {
        return new Date(isoString).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' });
      } catch { return isoString; }
    }
    function formatResponseTime(ms) {
      if (!ms || ms < 0) return '0ms';
      return ms < 1000 ? ms.toFixed(0) + 'ms' : (ms/1000).toFixed(2) + 's';
    }

    // 调试系统
    let debugEnabled = localStorage.getItem('debugEnabled') === 'true';
    let debugLogs = JSON.parse(localStorage.getItem('debugLogs') || '[]');
    function addDebugLog(message, data = null) {
      const timestamp = new Date().toLocaleString('zh-CN');
      const logEntry = { timestamp, message, data: data ? JSON.stringify(data).substring(0,200) : null };
      debugLogs.unshift(logEntry);
      if (debugLogs.length > 50) debugLogs.pop();
      localStorage.setItem('debugLogs', JSON.stringify(debugLogs));
      if (debugEnabled) updateDebugPanel();
    }
    function updateDebugPanel() {
      const debugContent = document.getElementById('debug-content');
      if (!debugContent) return;
      debugContent.innerHTML = debugLogs.map(log => \`
        <div class="debug-log">
          <div style="color:#81e6d9;font-size:11px;">\${log.timestamp}</div>
          <div>\${log.message}</div>
          \${log.data ? '<div style="color:#a0aec0;font-size:10px;">'+log.data+'</div>' : ''}
        </div>\`).join('');
    }
    function clearDebugLogs() { debugLogs = []; localStorage.setItem('debugLogs', JSON.stringify(debugLogs)); updateDebugPanel(); }
    function toggleDebug() {
      debugEnabled = !debugEnabled;
      localStorage.setItem('debugEnabled', debugEnabled);
      document.getElementById('debug-panel').style.display = debugEnabled ? 'block' : 'none';
      if (debugEnabled) updateDebugPanel();
    }

    // 数据加载
    async function loadBackendStats() {
      addDebugLog('开始加载后端统计');
      const container = document.getElementById('backend-stats-container');
      container.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p>正在加载后端服务器数据...</p></div>';
      try {
        const res = await fetch('/api/backend-stats?_t='+Date.now());
        if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
        const data = await res.json();
        addDebugLog('后端统计接收', { count: data.length });
        if (!data.length) {
          container.innerHTML = '<div class="empty-state"><i class="fas fa-server"></i><h3>暂无后端服务器</h3><button class="btn btn-primary" onclick="location.href=\\'/init\\'"><i class="fas fa-cog"></i> 前往设置</button></div>';
          return;
        }
        document.getElementById('total-backends').textContent = data.length;
        // 构建表格和卡片
        let tableHtml = '<div class="stats-table-container"><table class="stats-table"><thead><tr><th>后端地址 / 健康</th><th>请求统计</th><th>性能指标</th><th>权重状态</th></tr></thead><tbody>';
        let cardsHtml = '<div class="mobile-cards">';
        data.forEach(b => {
          const total = b.total_requests || 0;
          const success = b.success_count || 0;
          const fail = b.fail_count || 0;
          const rate = total ? ((success/total)*100).toFixed(1) : '0.0';
          const avgRT = b.average_response_time || 0;
          const ewma = (b.ewma_success_rate || 0.5).toFixed(3);
          const consec = b.consecutive_failures || 0;
          const healthy = b.healthy === 1;
          const disabledUntil = b.disabled_until ? formatBeijingTime(b.disabled_until) : null;
          const dynamicWeight = b.dynamic_weight || b.weight || ${config.INITIAL_WEIGHT};

          // 表格行
          tableHtml += \`<tr>
            <td data-label="后端地址">
              <div class="mobile-row"><strong>\${b.url || '未知'}</strong></div>
              <div style="display:flex;flex-wrap:wrap;gap:6px;">
                <span class="healthy-badge \${healthy ? 'healthy-true' : 'healthy-false'}">\${healthy ? '健康' : '不健康'}</span>
                \${b.enabled === 0 ? '<span class="status-badge status-failed">已禁用</span>' : ''}
                \${disabledUntil ? '<span class="status-badge status-failed">熔断至 '+disabledUntil+'</span>' : ''}
              </div>
              <div style="max-width:200px;overflow:hidden;text-overflow:ellipsis;word-break:break-all;">\${b.url || '未知'}</div>
            </td>
            <td data-label="请求统计">
              <div><small>总请求: \${total}</small></div>
              <div><small>成功: \${success} | 失败: \${fail}</small></div>
              <div><small>成功率: \${rate}%</small></div>
              <div class="progress-container"><div class="progress-bar" style="width:\${Math.min(rate,100)}%"></div></div>
            </td>
            <td data-label="性能指标">
              <div><small>平均响应: \${formatResponseTime(avgRT)}</small></div>
              <div><small>最后响应: \${formatResponseTime(b.last_response_time || 0)}</small></div>
              <div><small>EWMA成功率: \${ewma}</small></div>
              <div><small>连续失败: \${consec}</small></div>
            </td>
            <td data-label="权重状态">
              <div><small>基础权重: \${b.weight || ${config.INITIAL_WEIGHT}}</small></div>
              <div><small>动态权重: \${dynamicWeight.toFixed(1)}</small></div>
              <div><small>最后使用: \${b.last_used ? formatBeijingTime(b.last_used) : '从未'}</small></div>
              <div><small>最后健康检查: \${b.last_health_check ? formatBeijingTime(b.last_health_check) : '从未'}</small></div>
            </td>
          </tr>\`;

          // 卡片
          cardsHtml += \`<div class="mobile-card">
            <div class="mobile-card-header">
              <strong style="word-break:break-all;">\${b.url || '未知'}</strong>
              <span class="healthy-badge \${healthy ? 'healthy-true' : 'healthy-false'}">\${healthy ? '健康' : '不健康'}</span>
            </div>
            <div class="mobile-card-body">
              <div><span>总请求:</span> \${total}</div>
              <div><span>成功/失败:</span> \${success}/\${fail}</div>
              <div><span>成功率:</span> \${rate}% <span class="progress-container" style="width:60px; display:inline-block; margin-left:8px;"><div class="progress-bar" style="width:\${Math.min(rate,100)}%"></div></span></div>
              <div><span>平均响应:</span> \${formatResponseTime(avgRT)}</div>
              <div><span>动态权重:</span> \${dynamicWeight.toFixed(1)} (基础: \${b.weight || ${config.INITIAL_WEIGHT}})</div>
              <div><span>EWMA成功率:</span> \${ewma}</div>
              <div><span>连续失败:</span> \${consec}</div>
              <div><span>最后使用:</span> \${b.last_used ? formatBeijingTime(b.last_used) : '从未'}</div>
              \${disabledUntil ? '<div><span>熔断至:</span> '+disabledUntil+'</div>' : ''}
              <div><span>健康检查:</span> \${b.last_health_check ? formatBeijingTime(b.last_health_check) : '从未'}</div>
            </div>
          </div>\`;
        });
        tableHtml += '</tbody></table></div>';
        cardsHtml += '</div>';
        container.innerHTML = tableHtml + cardsHtml;
      } catch (e) {
        addDebugLog('加载后端统计失败', { error: e.message });
        container.innerHTML = '<div class="error-state"><i class="fas fa-exclamation-triangle"></i><h3>加载失败</h3><p>'+e.message+'</p><button class="btn btn-primary" onclick="loadBackendStats()"><i class="fas fa-redo"></i> 重新加载</button></div>';
      }
    }

    async function loadRecentRequests() {
      addDebugLog('开始加载最近请求');
      const container = document.getElementById('recent-requests-container');
      container.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p>正在加载请求记录...</p></div>';
      try {
        const res = await fetch('/api/recent-requests?_t='+Date.now());
        if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
        const data = await res.json();
        addDebugLog('最近请求接收', { count: data.length });
        if (!data.length) {
          container.innerHTML = '<div class="empty-state"><i class="fas fa-history"></i><h3>暂无请求记录</h3><p>系统尚未处理任何请求</p></div>';
          return;
        }
        let tableHtml = '<div class="stats-table-container"><table class="stats-table"><thead><tr><th>后端地址</th><th>状态</th><th>动态权重</th><th>响应时间</th><th>请求时间</th></tr></thead><tbody>';
        let cardsHtml = '<div class="mobile-cards">';
        data.forEach(r => {
          const statusClass = r.status === 'success' ? 'status-success' : 'status-failed';
          const statusText = r.status === 'success' ? '成功' : '失败';
          const weight = r.dynamic_weight || 0;
          const level = weight >= 15 ? '高' : weight >= 10 ? '中' : '低';

          tableHtml += \`<tr>
            <td data-label="后端地址"><div class="mobile-row"><strong>\${r.backend_url || '未知'}</strong></div><div style="max-width:180px;overflow:hidden;text-overflow:ellipsis;word-break:break-all;">\${r.backend_url || '未知'}</div></td>
            <td data-label="状态"><span class="status-badge \${statusClass}">\${statusText}</span>\${r.error_message ? '<div><small style="color:#718096;font-size:11px;">'+r.error_message.substring(0,40)+(r.error_message.length>40?'...':'')+'</small></div>' : ''}</td>
            <td data-label="动态权重"><div class="weight-info"><span class="weight-badge">\${weight.toFixed(1)}</span><div class="weight-label">\${level}权重</div></div></td>
            <td data-label="响应时间">\${formatResponseTime(r.response_time || 0)}</td>
            <td data-label="请求时间">\${formatBeijingTime(r.request_time || new Date().toISOString())}</td>
          </tr>\`;

          cardsHtml += \`<div class="mobile-card">
            <div class="mobile-card-header">
              <strong style="word-break:break-all;">\${r.backend_url || '未知'}</strong>
              <span class="status-badge \${statusClass}">\${statusText}</span>
            </div>
            <div class="mobile-card-body">
              <div><span>动态权重:</span> \${weight.toFixed(1)} (\${level})</div>
              <div><span>响应时间:</span> \${formatResponseTime(r.response_time || 0)}</div>
              <div><span>请求时间:</span> \${formatBeijingTime(r.request_time || new Date().toISOString())}</div>
              \${r.error_message ? '<div><span>错误:</span> '+r.error_message.substring(0,40)+(r.error_message.length>40?'...':'')+'</div>' : ''}
            </div>
          </div>\`;
        });
        tableHtml += '</tbody></table></div>';
        cardsHtml += '</div>';
        container.innerHTML = tableHtml + cardsHtml;
      } catch (e) {
        addDebugLog('加载最近请求失败', { error: e.message });
        container.innerHTML = '<div class="error-state"><i class="fas fa-exclamation-triangle"></i><h3>加载失败</h3><p>'+e.message+'</p><button class="btn btn-primary" onclick="loadRecentRequests()"><i class="fas fa-redo"></i> 重新加载</button></div>';
      }
    }

    function refreshData() {
      addDebugLog('手动刷新数据');
      document.getElementById('last-update-time').textContent = formatBeijingTime(new Date().toISOString());
      loadBackendStats();
      loadRecentRequests();
    }

    // 初始化
    document.addEventListener('DOMContentLoaded', () => {
      addDebugLog('页面加载完成');
      if (debugEnabled) { document.getElementById('debug-panel').style.display = 'block'; updateDebugPanel(); }
      document.getElementById('last-update-time').textContent = formatBeijingTime(new Date().toISOString());
      if (${backends.length} === 0) loadBackendStats();
      if (${requests.length} === 0) loadRecentRequests();
      setInterval(refreshData, 120000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshData(); });
    });
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'r') { e.preventDefault(); refreshData(); addDebugLog('快捷键刷新'); }
      if (e.ctrlKey && e.key === 'd') { e.preventDefault(); toggleDebug(); }
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

// ---------- 页面处理：初始化页面（保持不变）----------
async function handleInitPage(request, env) {
  const config = getConfig(env);
  const count = await env.DB.prepare('SELECT COUNT(*) as c FROM backend_servers').first();
  const hasBackends = count && count.c > 0;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>数据库初始化 - 订阅转换负载均衡</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      --success-gradient: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
      --warning-gradient: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      --card-bg: rgba(255,255,255,0.95);
      --text-primary: #2d3748;
      --text-secondary: #718096;
      --border-color: #e2e8f0;
      --shadow-lg: 0 20px 40px rgba(0,0,0,0.1);
      --radius-lg: 20px;
    }
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      font-family: 'Inter', sans-serif;
      background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: var(--text-primary);
    }
    .init-container {
      background: var(--card-bg);
      border-radius: var(--radius-lg);
      padding: 50px;
      max-width: 700px;
      width: 100%;
      box-shadow: var(--shadow-lg);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.2);
      text-align: center;
      animation: slideIn 0.6s ease-out;
    }
    @keyframes slideIn {
      from { opacity:0; transform:translateY(30px); }
      to { opacity:1; transform:translateY(0); }
    }
    .header { margin-bottom:40px; }
    .header-icon {
      width:80px; height:80px;
      background: var(--primary-gradient);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin:0 auto 20px;
      color: white;
      font-size:32px;
      box-shadow:0 10px 20px rgba(102,126,234,0.3);
    }
    h1 {
      font-size:32px;
      font-weight:700;
      background: var(--primary-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom:12px;
    }
    .subtitle { color:var(--text-secondary); font-size:16px; max-width:500px; margin:0 auto; }
    .status-card {
      background: linear-gradient(135deg, #f8fafc 0%, #edf2f7 100%);
      border-radius:16px;
      padding:30px;
      margin:30px 0;
      text-align:left;
      border:1px solid var(--border-color);
    }
    .status-card h2 {
      color:var(--text-primary);
      margin-bottom:25px;
      display:flex;
      align-items:center;
      gap:12px;
      font-size:20px;
    }
    .status-card h2 i {
      width:36px; height:36px;
      background: var(--primary-gradient);
      border-radius:10px;
      display:flex;
      align-items:center;
      justify-content:center;
      color:white;
      font-size:16px;
    }
    .status-grid {
      display:grid;
      grid-template-columns:repeat(auto-fit, minmax(250px,1fr));
      gap:20px;
    }
    .status-item {
      padding:20px;
      background:white;
      border-radius:12px;
      border:1px solid var(--border-color);
      transition:transform 0.3s ease, box-shadow 0.3s ease;
    }
    .status-item:hover { transform:translateY(-3px); box-shadow:0 10px 20px rgba(0,0,0,0.1); }
    .status-label {
      color:var(--text-secondary);
      font-size:14px;
      font-weight:500;
      margin-bottom:8px;
      display:flex;
      align-items:center;
      gap:8px;
    }
    .status-value {
      color:var(--text-primary);
      font-size:24px;
      font-weight:700;
      margin-bottom:4px;
    }
    .status-value.success { color:#38a169; }
    .status-value.warning { color:#d69e2e; }
    .status-hint { color:var(--text-secondary); font-size:13px; }
    .backend-list {
      background:white;
      border-radius:12px;
      padding:25px;
      margin:30px 0;
      border:1px solid var(--border-color);
      max-height:300px;
      overflow-y:auto;
    }
    .backend-list h3 {
      color:var(--text-primary);
      margin-bottom:20px;
      display:flex;
      align-items:center;
      gap:10px;
      font-size:18px;
    }
    .backend-list h3 i { color:#667eea; }
    .backend-url {
      padding:12px 15px;
      background:#f7fafc;
      border-radius:8px;
      margin-bottom:10px;
      display:flex;
      align-items:center;
      gap:12px;
      transition:background 0.3s ease;
    }
    .backend-url:hover { background:#edf2f7; }
    .backend-url i { color:#667eea; font-size:14px; min-width:20px; }
    .backend-url span { color:var(--text-primary); font-size:14px; word-break:break-all; }
    .message {
      padding:20px;
      border-radius:12px;
      margin:25px 0;
      display:none;
      animation:fadeIn 0.5s ease;
      text-align:left;
    }
    @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
    .message.success {
      background: linear-gradient(135deg, #c6f6d5 0%, #9ae6b4 100%);
      color: #22543d;
      border: 1px solid #9ae6b4;
      display:block;
    }
    .message.error {
      background: linear-gradient(135deg, #fed7d7 0%, #feb2b2 100%);
      color: #742a2a;
      border: 1px solid #feb2b2;
      display:block;
    }
    .message-content { display:flex; align-items:center; gap:15px; }
    .message-icon { font-size:24px; flex-shrink:0; }
    .btn-group { display:flex; flex-direction:column; gap:15px; margin-top:30px; }
    .btn {
      padding:18px 30px;
      border:none;
      border-radius:12px;
      font-size:16px;
      font-weight:600;
      cursor:pointer;
      transition:all 0.3s ease;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:12px;
      text-decoration:none;
      width:100%;
    }
    .btn-primary {
      background: var(--primary-gradient);
      color:white;
      box-shadow:0 4px 15px rgba(102,126,234,0.4);
    }
    .btn-primary:hover:not(:disabled) { transform:translateY(-3px); box-shadow:0 8px 25px rgba(102,126,234,0.5); }
    .btn-primary:disabled { opacity:0.7; cursor:not-allowed; transform:none; }
    .btn-secondary {
      background: white;
      color: var(--text-primary);
      border:2px solid var(--border-color);
    }
    .btn-secondary:hover { background:#f7fafc; transform:translateY(-3px); box-shadow:0 4px 15px rgba(0,0,0,0.1); }
    .btn-warning {
      background: var(--warning-gradient);
      color: white;
      box-shadow:0 4px 15px rgba(245,87,108,0.4);
    }
    .btn-warning:hover { transform:translateY(-3px); box-shadow:0 8px 25px rgba(245,87,108,0.5); }
    .modal-overlay {
      position: fixed;
      top:0; left:0; right:0; bottom:0;
      background: rgba(0,0,0,0.7);
      display: none;
      align-items: center;
      justify-content: center;
      z-index:1000;
      backdrop-filter: blur(5px);
      animation:fadeIn 0.3s ease;
    }
    .modal-content {
      background: white;
      border-radius:20px;
      padding:40px;
      max-width:500px;
      width:90%;
      box-shadow:0 25px 50px rgba(0,0,0,0.3);
      animation:slideIn 0.4s ease;
    }
    .modal-header { text-align:center; margin-bottom:25px; }
    .modal-icon {
      width:70px; height:70px;
      background: linear-gradient(135deg, #f5576c 0%, #f093fb 100%);
      border-radius:50%;
      display:flex;
      align-items:center;
      justify-content:center;
      margin:0 auto 20px;
      color:white;
      font-size:28px;
      box-shadow:0 10px 20px rgba(245,87,108,0.3);
    }
    .modal-title { font-size:24px; font-weight:700; color:#e53e3e; margin-bottom:10px; }
    .modal-body { color:var(--text-primary); line-height:1.6; margin-bottom:30px; text-align:center; }
    .modal-warning {
      background: linear-gradient(135deg, #fff5f5 0%, #fed7d7 100%);
      border-radius:12px;
      padding:20px;
      margin:20px 0;
      border:1px solid #feb2b2;
      text-align:left;
    }
    .modal-warning h4 { color:#742a2a; margin-bottom:10px; display:flex; align-items:center; gap:8px; }
    .modal-warning ul { list-style:none; padding:0; margin:10px 0; }
    .modal-warning li { padding:8px 0; color:#742a2a; display:flex; align-items:center; gap:10px; }
    .modal-warning li i { color:#e53e3e; font-size:12px; }
    .modal-actions { display:flex; gap:15px; justify-content:center; }
    .modal-btn {
      padding:15px 30px;
      border:none;
      border-radius:10px;
      font-size:16px;
      font-weight:600;
      cursor:pointer;
      transition:all 0.3s ease;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:10px;
      flex:1;
    }
    .modal-btn-cancel {
      background: white;
      color: var(--text-primary);
      border:2px solid var(--border-color);
    }
    .modal-btn-cancel:hover { background:#f7fafc; transform:translateY(-2px); box-shadow:0 4px 15px rgba(0,0,0,0.1); }
    .modal-btn-confirm {
      background: linear-gradient(135deg, #f5576c 0%, #f093fb 100%);
      color: white;
      box-shadow:0 4px 15px rgba(245,87,108,0.4);
    }
    .modal-btn-confirm:hover { transform:translateY(-2px); box-shadow:0 8px 25px rgba(245,87,108,0.5); }
    .spinner { animation:spin 1s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    @media (max-width:768px) {
      .init-container { padding:30px 20px; }
      h1 { font-size:26px; }
      .header-icon { width:60px; height:60px; font-size:24px; }
      .status-grid { grid-template-columns:1fr; }
      .btn { padding:16px 20px; font-size:15px; }
      .modal-content { padding:30px 20px; width:95%; }
      .modal-actions { flex-direction:column; }
      .modal-btn { width:100%; }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --card-bg: rgba(45,55,72,0.95);
        --text-primary: #f7fafc;
        --text-secondary: #a0aec0;
        --border-color: #4a5568;
      }
      body { background: linear-gradient(135deg, #1a202c 0%, #2d3748 100%); }
      .status-card { background: linear-gradient(135deg, #2d3748 0%, #4a5568 100%); }
      .status-item { background: #2d3748; }
      .backend-list { background: #2d3748; }
      .backend-url { background: #4a5568; }
      .backend-url:hover { background: #5a6778; }
      .btn-secondary { background: #4a5568; color: #f7fafc; }
      .btn-secondary:hover { background: #5a6778; }
      .modal-content { background: #2d3748; }
      .modal-warning { background: linear-gradient(135deg, #2d3748 0%, #4a5568 100%); border:1px solid #742a2a; }
      .modal-warning h4, .modal-warning li { color: #feb2b2; }
      .modal-btn-cancel { background: #4a5568; color: #f7fafc; border-color:#4a5568; }
      .modal-btn-cancel:hover { background: #5a6778; }
    }
  </style>
</head>
<body>
  <div class="init-container">
    <div class="header">
      <div class="header-icon"><i class="fas fa-database"></i></div>
      <h1>数据库初始化</h1>
      <p class="subtitle">订阅转换负载均衡系统的数据库配置与管理</p>
    </div>
    <div class="status-card">
      <h2><i class="fas fa-info-circle"></i> 当前系统状态</h2>
      <div class="status-grid">
        <div class="status-item">
          <div class="status-label"><i class="fas fa-table"></i> 数据库表状态</div>
          <div class="status-value success">已就绪</div>
          <div class="status-hint">后端表和日志表已创建</div>
        </div>
        <div class="status-item">
          <div class="status-label"><i class="fas fa-server"></i> 后端服务器</div>
          <div class="status-value ${hasBackends ? 'success' : 'warning'}">${hasBackends ? `已配置 (${count.c}个)` : '未配置'}</div>
          <div class="status-hint">${hasBackends ? '系统已准备就绪' : '需要初始化后端服务器'}</div>
        </div>
        <div class="status-item">
          <div class="status-label"><i class="fas fa-cogs"></i> 默认配置</div>
          <div class="status-value">${config.DEFAULT_BACKENDS.length} 个</div>
          <div class="status-hint">预设后端服务器地址</div>
        </div>
      </div>
    </div>
    <div class="backend-list">
      <h3><i class="fas fa-list"></i> 默认后端服务器列表</h3>
      ${config.DEFAULT_BACKENDS.map(url => `<div class="backend-url"><i class="fas fa-link"></i><span>${url}</span></div>`).join('')}
    </div>
    <div id="message" class="message"></div>
    <div class="btn-group">
      ${!hasBackends ? `
        <button id="init-btn" class="btn btn-primary" onclick="initializeDatabase()"><i class="fas fa-play-circle"></i> 初始化数据库（添加默认后端）</button>
        <button class="btn btn-secondary" onclick="location.href='/status'"><i class="fas fa-arrow-left"></i> 返回状态页面</button>
      ` : `
        <button class="btn btn-primary" onclick="location.href='/status'"><i class="fas fa-chart-bar"></i> 前往状态监控面板</button>
        <button class="btn btn-warning" onclick="showResetModal()"><i class="fas fa-redo"></i> 重置数据库</button>
        <button class="btn btn-secondary" onclick="location.href='/'"><i class="fas fa-home"></i> 返回首页</button>
      `}
    </div>
  </div>

  <div id="reset-modal" class="modal-overlay">
    <div class="modal-content">
      <div class="modal-header">
        <div class="modal-icon"><i class="fas fa-exclamation-triangle"></i></div>
        <h3 class="modal-title">确认重置数据库</h3>
      </div>
      <div class="modal-body">
        <p>此操作将删除所有现有数据，包括：</p>
        <div class="modal-warning">
          <h4><i class="fas fa-skull-crossbones"></i> 将被删除的数据</h4>
          <ul>
            <li><i class="fas fa-times-circle"></i> 所有后端服务器配置</li>
            <li><i class="fas fa-times-circle"></i> 所有请求历史记录</li>
            <li><i class="fas fa-times-circle"></i> 所有性能统计数据</li>
          </ul>
        </div>
        <p><strong>重置后系统将恢复到默认配置（${config.DEFAULT_BACKENDS.length}个后端服务器）。</strong></p>
        <p style="color:var(--text-secondary); font-size:14px; margin-top:15px;">此操作不可撤销，请谨慎操作！</p>
      </div>
      <div class="modal-actions">
        <button class="modal-btn modal-btn-cancel" onclick="closeResetModal()"><i class="fas fa-times"></i> 取消操作</button>
        <button class="modal-btn modal-btn-confirm" onclick="resetDatabase()"><i class="fas fa-check"></i> 确认重置</button>
      </div>
    </div>
  </div>

  <script>
    function showResetModal() { document.getElementById('reset-modal').style.display = 'flex'; document.body.style.overflow = 'hidden'; }
    function closeResetModal() { document.getElementById('reset-modal').style.display = 'none'; document.body.style.overflow = 'auto'; }
    document.getElementById('reset-modal').addEventListener('click', function(e) { if (e.target === this) closeResetModal(); });

    function showMessage(text, type, icon = 'info-circle') {
      const msg = document.getElementById('message');
      msg.className = 'message ' + type;
      msg.innerHTML = \`<div class="message-content"><div class="message-icon"><i class="fas fa-\${icon}"></i></div><div>\${text}</div></div>\`;
      msg.style.display = 'block';
      if (type === 'success') setTimeout(() => msg.style.display = 'none', 5000);
    }

    async function initializeDatabase() {
      const btn = document.getElementById('init-btn');
      const original = btn.innerHTML;
      btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner spinner"></i> 正在初始化...';
      try {
        showMessage('正在初始化数据库，请稍候...', 'success', 'spinner');
        const res = await fetch('/api/init-db', { method: 'POST' });
        const result = await res.json();
        if (result.success) {
          showMessage(\`<strong>数据库初始化成功！</strong><br>成功添加了 \${result.backends_added} 个后端服务器。\${result.errors.length ? ' ('+result.errors.length+'个失败)' : ''}<br>页面将在 3 秒后自动跳转...\`, 'success', 'check-circle');
          setTimeout(() => location.href = '/status', 3000);
        } else {
          showMessage(\`<strong>初始化失败！</strong><br>错误信息: \${result.error || '未知错误'}\`, 'error', 'times-circle');
          btn.disabled = false; btn.innerHTML = original;
        }
      } catch (e) {
        showMessage(\`<strong>请求失败！</strong><br>网络错误: \${e.message}\`, 'error', 'times-circle');
        btn.disabled = false; btn.innerHTML = original;
      }
    }

    async function resetDatabase() {
      closeResetModal();
      try {
        showMessage('正在重置数据库，请稍候...', 'success', 'spinner');
        const res = await fetch('/api/init-db', { method: 'POST' });
        const result = await res.json();
        if (result.success) {
          showMessage(\`<strong>数据库重置成功！</strong><br>已重新添加 \${result.backends_added} 个后端服务器。<br>页面将在 2 秒后刷新...\`, 'success', 'check-circle');
          setTimeout(() => location.reload(), 2000);
        } else {
          showMessage(\`<strong>重置失败！</strong><br>错误信息: \${result.error || '未知错误'}\`, 'error', 'times-circle');
        }
      } catch (e) {
        showMessage(\`<strong>请求失败！</strong><br>网络错误: \${e.message}\`, 'error', 'times-circle');
      }
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && ${!hasBackends}) { const btn = document.getElementById('init-btn'); if (btn && !btn.disabled) initializeDatabase(); }
      if (e.key === 'Escape') { if (document.getElementById('reset-modal').style.display === 'flex') closeResetModal(); else location.href = '/status'; }
    });
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('.status-item').forEach((item,i) => { item.style.animation = 'slideIn 0.5s ease-out forwards'; item.style.animationDelay = i*0.1+'s'; });
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

// ---------- 辅助格式化函数 ----------
function formatResponseTimeForHTML(ms) {
  if (!ms || ms < 0) return '0ms';
  return ms < 1000 ? ms.toFixed(0) + 'ms' : (ms / 1000).toFixed(2) + 's';
}

function formatBeijingTimeForHTML(isoString) {
  if (!isoString) return '从未';
  try {
    return new Date(isoString).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return isoString;
  }
}

// ---------- 主入口 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '86400' }
      });
    }

    if (!['/init', '/api/init-db', '/status'].includes(path)) {
      try {
        await ensureDatabaseInitialized(env);
      } catch (e) {
        logError('数据库初始化失败', e);
        if (path === '/status') return handleStatusPage(request, env);
        return Response.redirect(`${url.origin}/init`, 302);
      }
    }

    if (path === '/sub' || path.startsWith('/sub/')) return handleSubscriptionRequest(request, env, ctx);
    if (path === '/version') return handleVersionRequest(request, env, ctx);
    if (path === '/status') return handleStatusPage(request, env);
    if (path === '/init') return handleInitPage(request, env);
    if (path === '/api/init-db') return handleInitDatabase(request, env);
    if (path === '/api/backend-stats') return handleBackendStats(request, env);
    if (path === '/api/recent-requests') return handleRecentRequests(request, env);
    if (path === '/') return Response.redirect(`${url.origin}/status`, 302);
    return handleSubscriptionRequest(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(event, env, ctx));
  }
};