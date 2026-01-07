// Cloudflare Worker 主文件
// 订阅转换负载均衡系统

// 北京时区格式化
const BEIJING_TIMEZONE = 'Asia/Shanghai';

// 默认后端地址
// https://sub.xeton.dev
// https://api.wcc.best
const DEFAULT_BACKENDS = [
  'https://www.nameless13.com',
  'https://subapi.cmliussss.net',
  'https://subapi.sosoorg.com',
  'https://url.v1.mk'
];

// 权重配置
const INITIAL_WEIGHT = 10; // 初始权重
const SUCCESS_WEIGHT_INCREMENT = 1; // 成功时权重增加
const FAILURE_WEIGHT_DECREMENT = 2; // 失败时权重减少
const MAX_WEIGHT = 20; // 最大权重
const MIN_WEIGHT = 1;  // 最小权重

// 调试日志函数
function logDebug(message, data = null) {
  const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const logMessage = `[DEBUG][${timestamp}] ${message}`;
  if (data) {
    console.log(logMessage, JSON.stringify(data, null, 2));
  } else {
    console.log(logMessage);
  }
}

// 错误日志函数
function logError(message, error = null) {
  const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const errorMessage = `[ERROR][${timestamp}] ${message}`;
  if (error) {
    console.error(errorMessage, error.stack || error.message || error);
  } else {
    console.error(errorMessage);
  }
}

// 信息日志函数
function logInfo(message, data = null) {
  const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const infoMessage = `[INFO][${timestamp}] ${message}`;
  if (data) {
    console.log(infoMessage, JSON.stringify(data, null, 2));
  } else {
    console.log(infoMessage);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    
    logInfo(`收到请求: ${request.method} ${url.pathname}${url.search}`);
    logDebug('请求头信息:', Object.fromEntries(request.headers.entries()));
    
    // 处理 OPTIONS 预检请求（CORS）
    if (request.method === 'OPTIONS') {
      logInfo('处理 OPTIONS 预检请求');
      return handleOptions(request);
    }
    
    // 首先确保数据库已初始化
    try {
      await ensureDatabaseInitialized(env);
      logInfo('数据库初始化检查完成');
    } catch (error) {
      logError('数据库初始化失败', error);
      // 如果是状态页面，仍然返回HTML让用户能看到初始化按钮
      if (pathname === '/status') {
        logInfo('数据库未初始化，返回状态页面');
        return handleStatusPage(request, env, false);
      }
      // 如果是初始化页面，允许访问
      if (pathname === '/init' || pathname === '/api/init-db') {
        logInfo('访问初始化相关页面，继续处理');
        // 继续处理
      } else {
        // 其他页面重定向到初始化页面
        logInfo(`数据库未初始化，重定向到初始化页面: ${url.origin}/init`);
        return Response.redirect(`${url.origin}/init`, 302);
      }
    }
    
    // 路由处理
    if (pathname === '/sub' || pathname.startsWith('/sub/')) {
      logInfo('处理订阅转换请求');
      return handleSubscriptionRequest(request, env);
    } else if (pathname === '/version') {
      logInfo('处理版本请求');
      return handleVersionRequest(request, env);
    } else if (pathname === '/status') {
      logInfo('处理状态页面请求');
      return handleStatusPage(request, env, true);
    } else if (pathname === '/init') {
      logInfo('处理初始化页面请求');
      return handleInitPage(request, env);
    } else if (pathname === '/api/init-db') {
      logInfo('处理数据库初始化API请求');
      return handleInitDatabase(request, env);
    } else if (pathname === '/api/backend-stats') {
      logInfo('处理后端统计API请求');
      return handleBackendStats(request, env);
    } else if (pathname === '/api/recent-requests') {
      logInfo('处理最近请求API请求');
      return handleRecentRequests(request, env);
    } else if (pathname === '/') {
      logInfo('根路径重定向到状态页面');
      return Response.redirect(`${url.origin}/status`, 302);
    } else {
      logInfo(`其他路径转发到订阅转换: ${pathname}`);
      return handleSubscriptionRequest(request, env);
    }
  }
};

// 处理 CORS 预检请求
function handleOptions(request) {
  const headers = request.headers;
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': headers.get('Access-Control-Request-Headers') || '*',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// 确保数据库已初始化
async function ensureDatabaseInitialized(env) {
  logDebug('开始检查数据库初始化状态');
  try {
    // 检查表是否存在
    const tables = await env.DB.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name IN ('backend_servers', 'request_logs')
    `).all();
    
    logDebug('数据库表检查结果:', tables);
    
    // 如果表不存在，创建它们
    if (!tables.results || tables.results.length < 2) {
      logInfo('数据库表不存在，开始创建表');
      await createDatabaseTables(env);
      logInfo('数据库表创建完成');
    } else {
      logDebug('数据库表已存在');
    }
    return true;
  } catch (error) {
    logError('检查数据库初始化状态失败', error);
    throw error;
  }
}

// 创建数据库表
async function createDatabaseTables(env) {
  try {
    logDebug('开始创建数据库表');
    
    // 创建后端服务器表
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS backend_servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        weight INTEGER DEFAULT ${INITIAL_WEIGHT},
        dynamic_weight REAL DEFAULT ${INITIAL_WEIGHT},
        total_requests INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        average_response_time REAL DEFAULT 0,
        last_response_time REAL DEFAULT 0,
        last_used TIMESTAMP,
        enabled BOOLEAN DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    
    logDebug('后端服务器表创建成功');
    
    // 创建请求日志表
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backend_url TEXT NOT NULL,
        response_time REAL NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        request_time TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    
    logDebug('请求日志表创建成功');
    
    // 创建索引
    await env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_request_logs_time ON request_logs(request_time DESC)
    `).run();
    
    await env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_backend_servers_weight ON backend_servers(dynamic_weight DESC)
    `).run();
    
    logDebug('数据库索引创建成功');
    logInfo('数据库表创建完成');
    return true;
  } catch (error) {
    logError('创建数据库表失败', error);
    throw error;
  }
}

// 处理订阅转换请求
async function handleSubscriptionRequest(request, env) {
  logDebug('开始处理订阅转换请求');
  try {
    // 获取后端列表并智能选择
    const backend = await selectBackend(env);
    logDebug('选择的后端:', backend);
    
    if (!backend) {
      logError('没有可用的后端服务器');
      return new Response('No available backend servers', { 
        status: 503,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'text/plain; charset=utf-8'
        }
      });
    }
    
    // 构建转发URL
    const originalUrl = new URL(request.url);
    const backendUrl = `${backend.url}${originalUrl.pathname}${originalUrl.search}`;
    logInfo(`转发请求到后端: ${backendUrl}`);
    
    // 记录开始时间
    const startTime = Date.now();
    
    // 准备转发请求
    const forwardRequest = new Request(backendUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual'
    });
    
    let response;
    let status = 'success';
    let errorMsg = '';
    let responseTime = 0;
    
    try {
      // 转发请求
      logDebug('开始转发请求到后端');
      response = await fetch(forwardRequest);
      responseTime = Date.now() - startTime;
      logInfo(`后端响应时间: ${responseTime}ms, 状态码: ${response.status}`);
      
      // 检查响应状态
      if (!response.ok) {
        status = 'failed';
        errorMsg = `HTTP ${response.status}: ${response.statusText}`;
        logError(`后端响应失败: ${errorMsg}`);
      } else {
        logInfo('后端响应成功');
      }
      
      // 更新后端统计信息
      await updateBackendStats(env, backend.id, status === 'success', responseTime);
      
      // 记录请求日志
      await logRequest(env, {
        backend_url: backend.url,
        response_time: responseTime,
        status: status,
        error_message: errorMsg,
        request_time: new Date().toISOString()
      });
      
      // 创建新的响应头（避免缓存）
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      headers.set('Pragma', 'no-cache');
      headers.set('Expires', '0');
      
      logInfo('请求处理完成，返回响应');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
      });
      
    } catch (error) {
      responseTime = Date.now() - startTime;
      status = 'failed';
      errorMsg = error.message;
      logError('请求后端时发生错误', error);
      
      // 更新后端统计信息（失败）
      await updateBackendStats(env, backend.id, false, responseTime);
      
      // 记录请求日志
      await logRequest(env, {
        backend_url: backend.url,
        response_time: responseTime,
        status: status,
        error_message: errorMsg,
        request_time: new Date().toISOString()
      });
      
      return new Response(`Backend error: ${error.message}`, {
        status: 502,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'text/plain; charset=utf-8'
        }
      });
    }
    
  } catch (error) {
    logError('处理订阅请求时发生内部错误', error);
    return new Response(`Internal error: ${error.message}`, {
      status: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });
  }
}

// 处理版本请求
async function handleVersionRequest(request, env) {
  logDebug('开始处理版本请求');
  try {
    // 选择后端
    const backend = await selectBackend(env);
    if (!backend) {
      logError('没有可用的后端服务器用于版本检查');
      return new Response('No available backend servers', { status: 503 });
    }
    
    logInfo(`检查后端版本: ${backend.url}`);
    
    // 获取版本信息
    const versionUrl = `${backend.url}/version`;
    const response = await fetch(versionUrl, {
      headers: {
        'User-Agent': 'subconverter-loadbalancer/1.0'
      }
    });
    
    if (!response.ok) {
      logError(`后端版本检查失败: ${response.status}`);
      return new Response(`Backend version check failed: ${response.status}`, {
        status: response.status
      });
    }
    
    const versionText = await response.text();
    logInfo(`后端版本: ${versionText.substring(0, 100)}...`);
    
    return new Response(versionText, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
    
  } catch (error) {
    logError('版本检查错误', error);
    return new Response(`Version check error: ${error.message}`, {
      status: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });
  }
}

// 智能选择后端（加权轮询）
async function selectBackend(env) {
  logDebug('开始选择后端');
  try {
    // 从数据库获取所有启用的后端
    const result = await env.DB.prepare(`
      SELECT id, url, weight, total_requests, success_count, fail_count, 
             average_response_time, dynamic_weight
      FROM backend_servers
      WHERE enabled = 1
      ORDER BY dynamic_weight DESC, average_response_time ASC
    `).all();
    
    logDebug('数据库查询结果:', result);
    
    if (!result.results || result.results.length === 0) {
      logError('数据库中没有启用的后端服务器');
      return null;
    }
    
    const backends = result.results;
    logInfo(`找到 ${backends.length} 个启用的后端服务器`);
    
    // 计算总权重
    let totalWeight = 0;
    for (const backend of backends) {
      totalWeight += backend.dynamic_weight || backend.weight || INITIAL_WEIGHT;
    }
    
    // 如果没有配置动态权重，使用基础权重
    if (totalWeight === 0) {
      logDebug('动态权重为0，使用基础权重');
      for (const backend of backends) {
        totalWeight += backend.weight || INITIAL_WEIGHT;
      }
    }
    
    logDebug(`总权重: ${totalWeight}`);
    
    // 随机选择一个（基于权重）
    let random = Math.random() * totalWeight;
    let selectedBackend = null;
    
    for (const backend of backends) {
      const weight = backend.dynamic_weight || backend.weight || INITIAL_WEIGHT;
      random -= weight;
      if (random <= 0) {
        selectedBackend = backend;
        break;
      }
    }
    
    // 如果随机选择失败，选择第一个
    if (!selectedBackend) {
      logDebug('随机选择失败，选择第一个后端');
      selectedBackend = backends[0];
    }
    
    logInfo(`选择了后端: ${selectedBackend.url}, 权重: ${selectedBackend.dynamic_weight || selectedBackend.weight}`);
    return selectedBackend;
    
  } catch (error) {
    logError('选择后端时发生错误', error);
    return null;
  }
}

// 更新后端统计信息
async function updateBackendStats(env, backendId, success, responseTime) {
  logDebug(`更新后端统计: id=${backendId}, success=${success}, responseTime=${responseTime}ms`);
  try {
    // 获取当前统计信息
    const result = await env.DB.prepare(`
      SELECT total_requests, success_count, fail_count, average_response_time, weight, dynamic_weight
      FROM backend_servers
      WHERE id = ?
    `).bind(backendId).first();
    
    if (!result) {
      logError(`找不到后端ID: ${backendId}`);
      return;
    }
    
    logDebug('当前后端统计:', result);
    
    // 计算新的统计数据
    const totalRequests = result.total_requests + 1;
    const successCount = result.success_count + (success ? 1 : 0);
    const failCount = result.fail_count + (success ? 0 : 1);
    
    // 计算新的平均响应时间
    let avgResponseTime;
    if (result.total_requests === 0) {
      avgResponseTime = responseTime;
    } else {
      avgResponseTime = (result.average_response_time * result.total_requests + responseTime) / totalRequests;
    }
    
    // 更新动态权重
    let dynamicWeight = result.dynamic_weight || result.weight || INITIAL_WEIGHT;
    if (success) {
      dynamicWeight = Math.min(dynamicWeight + SUCCESS_WEIGHT_INCREMENT, MAX_WEIGHT);
      logDebug(`请求成功，权重增加: ${dynamicWeight}`);
    } else {
      dynamicWeight = Math.max(dynamicWeight - FAILURE_WEIGHT_DECREMENT, MIN_WEIGHT);
      logDebug(`请求失败，权重减少: ${dynamicWeight}`);
    }
    
    // 更新数据库
    await env.DB.prepare(`
      UPDATE backend_servers 
      SET total_requests = ?, 
          success_count = ?, 
          fail_count = ?, 
          average_response_time = ?,
          last_response_time = ?,
          dynamic_weight = ?,
          last_used = datetime('now')
      WHERE id = ?
    `).bind(
      totalRequests,
      successCount,
      failCount,
      avgResponseTime,
      responseTime,
      dynamicWeight,
      backendId
    ).run();
    
    logInfo(`后端统计更新完成: id=${backendId}, 总请求=${totalRequests}, 成功=${successCount}, 失败=${failCount}, 平均响应=${avgResponseTime.toFixed(2)}ms, 动态权重=${dynamicWeight}`);
    
  } catch (error) {
    logError('更新后端统计时发生错误', error);
  }
}

// 记录请求日志
async function logRequest(env, data) {
  logDebug('记录请求日志:', data);
  try {
    await env.DB.prepare(`
      INSERT INTO request_logs (backend_url, response_time, status, error_message, request_time)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      data.backend_url,
      data.response_time,
      data.status,
      data.error_message || '',
      data.request_time
    ).run();
    
    logDebug('请求日志插入成功');
    
    // 清理旧的日志（保留最近1000条）
    await env.DB.prepare(`
      DELETE FROM request_logs 
      WHERE id NOT IN (
        SELECT id FROM request_logs 
        ORDER BY request_time DESC 
        LIMIT 1000
      )
    `).run();
    
    logDebug('清理旧日志完成');
    
  } catch (error) {
    logError('记录请求日志时发生错误', error);
  }
}

// API: 获取后端统计
async function handleBackendStats(request, env) {
  logDebug('开始获取后端统计');
  try {
    // 添加时间戳避免缓存
    const startTime = Date.now();
    
    const result = await env.DB.prepare(`
      SELECT 
        id, url, weight, dynamic_weight,
        total_requests, success_count, fail_count,
        average_response_time, last_response_time,
        last_used, enabled,
        created_at
      FROM backend_servers
      ORDER BY dynamic_weight DESC
    `).all();
    
    const endTime = Date.now();
    logDebug(`获取后端统计成功: 找到${result.results?.length || 0}条记录, 耗时${endTime - startTime}ms`);
    
    // 确保返回的是数组
    const data = result.results || [];
    
    // 格式化数据，确保所有字段都有值
    const formattedData = data.map(backend => ({
      id: backend.id || 0,
      url: backend.url || '未知',
      weight: backend.weight || INITIAL_WEIGHT,
      dynamic_weight: backend.dynamic_weight || backend.weight || INITIAL_WEIGHT,
      total_requests: backend.total_requests || 0,
      success_count: backend.success_count || 0,
      fail_count: backend.fail_count || 0,
      average_response_time: backend.average_response_time || 0,
      last_response_time: backend.last_response_time || 0,
      last_used: backend.last_used || null,
      enabled: backend.enabled !== undefined ? backend.enabled : 1,
      created_at: backend.created_at || new Date().toISOString()
    }));
    
    return new Response(JSON.stringify(formattedData), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    });
    
  } catch (error) {
    logError('获取后端统计时发生错误', error);
    return new Response(JSON.stringify({
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      }
    });
  }
}

// API: 获取最近请求
async function handleRecentRequests(request, env) {
  logDebug('开始获取最近请求');
  try {
    const result = await env.DB.prepare(`
      SELECT 
        id, backend_url, response_time, status, error_message, request_time,
        created_at
      FROM request_logs
      ORDER BY request_time DESC
      LIMIT 20
    `).all();
    
    logDebug(`获取最近请求成功: 找到${result.results?.length || 0}条记录`);
    
    // 确保返回的是数组
    const data = result.results || [];
    
    // 格式化数据
    const formattedData = data.map(log => ({
      id: log.id || 0,
      backend_url: log.backend_url || '未知',
      response_time: log.response_time || 0,
      status: log.status || 'unknown',
      error_message: log.error_message || '',
      request_time: log.request_time || new Date().toISOString(),
      created_at: log.created_at || new Date().toISOString()
    }));
    
    return new Response(JSON.stringify(formattedData), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
      }
    });
    
  } catch (error) {
    logError('获取最近请求时发生错误', error);
    return new Response(JSON.stringify({
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      }
    });
  }
}

// 状态页面
async function handleStatusPage(request, env, isInitialized) {
  logInfo('处理状态页面请求');
  
  // 首先确保数据库已初始化
  if (!isInitialized) {
    try {
      await ensureDatabaseInitialized(env);
      isInitialized = true;
    } catch (error) {
      // 如果初始化失败，跳转到初始化页面
      logError('状态页面: 数据库初始化失败', error);
      return Response.redirect(`${new URL(request.url).origin}/init`, 302);
    }
  }
  
  // 获取数据用于初始渲染（避免完全依赖客户端JavaScript）
  let backendStats = [];
  let recentRequests = [];
  
  try {
    const statsResult = await env.DB.prepare(`
      SELECT 
        id, url, weight, dynamic_weight,
        total_requests, success_count, fail_count,
        average_response_time, last_response_time,
        last_used, enabled
      FROM backend_servers
      ORDER BY dynamic_weight DESC
      LIMIT 10
    `).all();
    
    backendStats = statsResult.results || [];
    
    const logsResult = await env.DB.prepare(`
      SELECT 
        backend_url, response_time, status, error_message, request_time
      FROM request_logs
      ORDER BY request_time DESC
      LIMIT 10
    `).all();
    
    recentRequests = logsResult.results || [];
  } catch (error) {
    logError('获取状态页面初始数据失败', error);
    // 继续渲染页面，客户端JavaScript会重新加载
  }
  
  // 美化后的HTML
  const html = `
    <!DOCTYPE html>
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
          --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.1);
          --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.1);
          --shadow-lg: 0 10px 25px rgba(0, 0, 0, 0.1);
          --radius-md: 12px;
          --radius-lg: 16px;
        }
        
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
          min-height: 100vh;
          color: var(--text-primary);
          line-height: 1.6;
          padding: 20px;
        }
        
        .container {
          max-width: 1400px;
          margin: 0 auto;
        }
        
        /* 头部样式 */
        .header {
          background: var(--card-bg);
          border-radius: var(--radius-lg);
          padding: 30px;
          margin-bottom: 30px;
          box-shadow: var(--shadow-lg);
          backdrop-filter: blur(10px);
          border: 1px solid rgba(255, 255, 255, 0.2);
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
        
        .title-section p {
          color: var(--text-secondary);
          font-size: 16px;
        }
        
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
        
        /* 按钮组 */
        .action-buttons {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
        }
        
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
        
        /* 统计卡片网格 */
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
          gap: 25px;
          margin-bottom: 30px;
        }
        
        @media (max-width: 768px) {
          .stats-grid {
            grid-template-columns: 1fr;
          }
        }
        
        /* 卡片样式 */
        .card {
          background: var(--card-bg);
          border-radius: var(--radius-lg);
          padding: 30px;
          box-shadow: var(--shadow-lg);
          backdrop-filter: blur(10px);
          border: 1px solid rgba(255, 255, 255, 0.2);
          transition: transform 0.3s ease;
        }
        
        .card:hover {
          transform: translateY(-5px);
        }
        
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
        
        /* 表格样式 */
        .stats-table-container {
          overflow-x: auto;
          border-radius: 10px;
          background: white;
          box-shadow: var(--shadow-sm);
        }
        
        .stats-table {
          width: 100%;
          border-collapse: collapse;
          min-width: 600px;
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
        
        .stats-table th:first-child {
          border-top-left-radius: 10px;
        }
        
        .stats-table th:last-child {
          border-top-right-radius: 10px;
        }
        
        .stats-table tbody tr {
          border-bottom: 1px solid var(--border-color);
          transition: background 0.2s ease;
        }
        
        .stats-table tbody tr:hover {
          background: #f8fafc;
        }
        
        .stats-table tbody tr:last-child {
          border-bottom: none;
        }
        
        .stats-table td {
          padding: 18px 20px;
          color: var(--text-primary);
        }
        
        /* 状态徽章 */
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
        
        /* 进度条 */
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
        
        /* 加载状态 */
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
        
        /* 响应式表格单元格 */
        .mobile-row {
          display: none;
        }
        
        /* 调试信息 */
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
        
        .debug-header h4 {
          color: #81e6d9;
        }
        
        .debug-log {
          padding: 8px 0;
          border-bottom: 1px solid #2d3748;
        }
        
        .debug-log:last-child {
          border-bottom: none;
        }
        
        /* 动画 */
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        
        .fade-in {
          animation: fadeIn 0.5s ease-out;
        }
        
        /* 移动端优化 */
        @media (max-width: 768px) {
          body {
            padding: 15px;
          }
          
          .header {
            padding: 20px;
          }
          
          .header-content {
            flex-direction: column;
            align-items: stretch;
          }
          
          .action-buttons {
            justify-content: center;
          }
          
          .btn {
            padding: 10px 16px;
            font-size: 13px;
          }
          
          .stats-table {
            min-width: auto;
          }
          
          .stats-table thead {
            display: none;
          }
          
          .stats-table tbody tr {
            display: block;
            margin-bottom: 15px;
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 15px;
          }
          
          .stats-table td {
            display: block;
            padding: 8px 0;
            border: none;
          }
          
          .stats-table td:before {
            content: attr(data-label);
            font-weight: 600;
            color: var(--text-secondary);
            display: block;
            margin-bottom: 4px;
            font-size: 12px;
            text-transform: uppercase;
          }
          
          .mobile-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
          }
          
          /* 修改：移动端后端地址只显示mobile-row，隐藏桌面端div */
          #backend-stats-container .stats-table td:first-child > div:not(.mobile-row) {
            display: none !important;
          }
          
          #backend-stats-container .stats-table td:first-child .mobile-row {
            display: block;
            margin-bottom: 0;
          }
          
          #backend-stats-container .stats-table td:first-child .mobile-row strong {
            display: block;
            word-break: break-all;
            font-size: 14px;
            color: var(--text-primary);
          }
          
          /* 修改：移动端最近请求记录后端地址移除状态徽章 */
          #recent-requests-container .stats-table td:first-child .mobile-row .status-badge {
            display: none !important;
          }
          
          #recent-requests-container .stats-table td:first-child > div:not(.mobile-row) {
            display: none !important;
          }
          
          #recent-requests-container .stats-table td:first-child .mobile-row {
            display: block;
            margin-bottom: 0;
            justify-content: flex-start;
          }
          
          #recent-requests-container .stats-table td:first-child .mobile-row span:not(.status-badge) {
            display: block;
            word-break: break-all;
            font-size: 14px;
            color: var(--text-primary);
          }
        }
        
        /* 亮色/暗色主题切换支持 */
        @media (prefers-color-scheme: dark) {
          :root {
            --card-bg: rgba(45, 55, 72, 0.95);
            --text-primary: #f7fafc;
            --text-secondary: #a0aec0;
            --border-color: #4a5568;
          }
          
          body {
            background: linear-gradient(135deg, #1a202c 0%, #2d3748 100%);
          }
          
          .card {
            border: 1px solid rgba(255, 255, 255, 0.1);
          }
          
          .stats-table-container {
            background: #2d3748;
          }
          
          .stats-table tbody tr:hover {
            background: #4a5568;
          }
          
          .progress-container {
            background: #4a5568;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header fade-in">
          <div class="header-content">
            <div class="title-section">
              <h1>
                <i class="fas fa-balance-scale"></i>
                订阅转换负载均衡系统
                <span class="badge">v1.0.0</span>
              </h1>
              <p>智能加权轮询 | 实时监控 | 性能统计</p>
            </div>
            <div class="action-buttons">
              <button class="btn btn-primary" onclick="refreshData()">
                <i class="fas fa-sync-alt"></i> 刷新数据
              </button>
              <button class="btn btn-secondary" onclick="location.href='/init'">
                <i class="fas fa-cog"></i> 系统设置
              </button>
              <button class="btn btn-secondary" onclick="toggleDebug()">
                <i class="fas fa-terminal"></i> 调试模式
              </button>
            </div>
          </div>
          
          <div id="debug-panel" class="debug-panel" style="display: none;">
            <div class="debug-header">
              <h4><i class="fas fa-bug"></i> 系统调试信息</h4>
              <button class="btn btn-secondary" onclick="clearDebugLogs()" style="padding: 4px 8px; font-size: 11px;">
                清空日志
              </button>
            </div>
            <div id="debug-content"></div>
          </div>
        </div>
        
        <div class="stats-grid">
          <!-- 后端服务器状态卡片 -->
          <div class="card fade-in" style="animation-delay: 0.1s;">
            <div class="card-header">
              <h2>
                <span class="icon server-icon">
                  <i class="fas fa-server"></i>
                </span>
                后端服务器状态
              </h2>
              <div class="stats-info">
                <span style="color: var(--text-secondary); font-size: 14px;">
                  总计: <span id="total-backends">${backendStats.length}</span> 个
                </span>
              </div>
            </div>
            <div id="backend-stats-container">
              ${backendStats.length > 0 ? `
                <div class="stats-table-container">
                  <table class="stats-table">
                    <thead>
                      <tr>
                        <th>后端地址</th>
                        <th>请求统计</th>
                        <th>性能指标</th>
                        <th>权重状态</th>
                      </tr>
                    </thead>
                    <tbody id="backend-stats-body">
                      ${backendStats.map(backend => {
                        const totalRequests = backend.total_requests || 0;
                        const successCount = backend.success_count || 0;
                        const successRate = totalRequests > 0 ? ((successCount / totalRequests) * 100).toFixed(1) : '0.0';
                        const avgResponseTime = backend.average_response_time || 0;
                        const dynamicWeight = backend.dynamic_weight || backend.weight || INITIAL_WEIGHT;
                        
                        return `
                        <tr>
                          <td data-label="后端地址">
                            <div class="mobile-row">
                              <strong>${backend.url || '未知'}</strong>
                              ${backend.enabled === 0 ? '<span class="status-badge status-failed" style="margin-left: 8px;">已禁用</span>' : ''}
                            </div>
                            <div style="max-width: 200px; overflow: hidden; text-overflow: ellipsis;">
                              ${backend.url || '未知'}
                            </div>
                            ${backend.enabled === 0 ? '<div><span class="status-badge status-failed">已禁用</span></div>' : ''}
                          </td>
                          <td data-label="请求统计">
                            <div style="margin-bottom: 4px;">
                              <small>总请求: ${totalRequests}</small>
                            </div>
                            <div style="margin-bottom: 4px;">
                              <small>成功: ${successCount} | 失败: ${backend.fail_count || 0}</small>
                            </div>
                            <div>
                              <small>成功率: ${successRate}%</small>
                            </div>
                            <div class="progress-container">
                              <div class="progress-bar" style="width: ${Math.min(successRate, 100)}%"></div>
                            </div>
                          </td>
                          <td data-label="性能指标">
                            <div style="margin-bottom: 4px;">
                              <small>平均响应: ${formatResponseTimeForHTML(avgResponseTime)}</small>
                            </div>
                            <div>
                              <small>最后响应: ${formatResponseTimeForHTML(backend.last_response_time || 0)}</small>
                            </div>
                          </td>
                          <td data-label="权重状态">
                            <div style="margin-bottom: 4px;">
                              <small>基础权重: ${backend.weight || INITIAL_WEIGHT}</small>
                            </div>
                            <div style="margin-bottom: 4px;">
                              <small>动态权重: ${dynamicWeight.toFixed(1)}</small>
                            </div>
                            <div>
                              <small>最后使用: ${backend.last_used ? formatBeijingTimeForHTML(backend.last_used) : '从未'}</small>
                            </div>
                          </td>
                        </tr>
                        `;
                      }).join('')}
                    </tbody>
                  </table>
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
          <div class="card fade-in" style="animation-delay: 0.2s;">
            <div class="card-header">
              <h2>
                <span class="icon history-icon">
                  <i class="fas fa-history"></i>
                </span>
                最近请求记录
              </h2>
              <div class="stats-info">
                <span style="color: var(--text-secondary); font-size: 14px;">
                  最近20条记录
                </span>
              </div>
            </div>
            <div id="recent-requests-container">
              ${recentRequests.length > 0 ? `
                <div class="stats-table-container">
                  <table class="stats-table">
                    <thead>
                      <tr>
                        <th>后端地址</th>
                        <th>状态</th>
                        <th>响应时间</th>
                        <th>请求时间</th>
                      </tr>
                    </thead>
                    <tbody id="recent-requests-body">
                      ${recentRequests.map(log => {
                        const statusClass = log.status === 'success' ? 'status-success' : 'status-failed';
                        const statusText = log.status === 'success' ? '成功' : '失败';
                        
                        return `
                        <tr>
                          <td data-label="后端地址">
                            <div class="mobile-row">
                              ${log.backend_url || '未知'}
                            </div>
                            <div style="max-width: 180px; overflow: hidden; text-overflow: ellipsis;">
                              ${log.backend_url || '未知'}
                            </div>
                          </td>
                          <td data-label="状态">
                            <span class="status-badge ${statusClass}">${statusText}</span>
                            ${log.error_message ? `
                              <div style="margin-top: 4px;">
                                <small style="color: #718096; font-size: 11px;">
                                  ${log.error_message.substring(0, 40)}${log.error_message.length > 40 ? '...' : ''}
                                </small>
                              </div>
                            ` : ''}
                          </td>
                          <td data-label="响应时间">
                            ${formatResponseTimeForHTML(log.response_time || 0)}
                          </td>
                          <td data-label="请求时间">
                            ${formatBeijingTimeForHTML(log.request_time || new Date().toISOString())}
                          </td>
                        </tr>
                        `;
                      }).join('')}
                    </tbody>
                  </table>
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
        <div class="card fade-in" style="animation-delay: 0.3s; margin-top: 25px;">
          <div class="card-header">
            <h2>
              <span class="icon" style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white;">
                <i class="fas fa-info-circle"></i>
              </span>
              系统信息
            </h2>
          </div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px;">
            <div class="info-item">
              <h3 style="color: var(--text-secondary); font-size: 14px; margin-bottom: 8px;">权重算法</h3>
              <p style="font-size: 16px; font-weight: 500;">
                成功: +${SUCCESS_WEIGHT_INCREMENT}, 失败: -${FAILURE_WEIGHT_DECREMENT}
              </p>
              <p style="font-size: 13px; color: var(--text-secondary);">
                范围: ${MIN_WEIGHT} - ${MAX_WEIGHT}
              </p>
            </div>
            <div class="info-item">
              <h3 style="color: var(--text-secondary); font-size: 14px; margin-bottom: 8px;">最近活动</h3>
              <p style="font-size: 16px; font-weight: 500;" id="last-update-time">
                正在更新...
              </p>
              <p style="font-size: 13px; color: var(--text-secondary);">
                每120秒自动刷新
              </p>
            </div>
            <div class="info-item">
              <h3 style="color: var(--text-secondary); font-size: 14px; margin-bottom: 8px;">数据统计</h3>
              <p style="font-size: 16px; font-weight: 500;">
                保留最近 <strong>1000</strong> 条日志
              </p>
              <p style="font-size: 13px; color: var(--text-secondary);">
                基于动态权重智能选择
              </p>
            </div>
          </div>
        </div>
      </div>
      
      <script>
        // 工具函数
        function formatBeijingTime(isoString) {
          if (!isoString) return '从未';
          try {
            const date = new Date(isoString);
            return date.toLocaleString('zh-CN', { 
              timeZone: 'Asia/Shanghai',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            });
          } catch (e) {
            console.error('时间格式化错误:', e);
            return isoString;
          }
        }
        
        function formatResponseTime(ms) {
          if (!ms || ms < 0) return '0ms';
          if (ms < 1000) return ms.toFixed(0) + 'ms';
          return (ms / 1000).toFixed(2) + 's';
        }
        
        // 调试系统
        let debugEnabled = localStorage.getItem('debugEnabled') === 'true';
        let debugLogs = JSON.parse(localStorage.getItem('debugLogs') || '[]');
        
        function addDebugLog(message, data = null) {
          const timestamp = new Date().toLocaleString('zh-CN');
          const logEntry = {
            timestamp,
            message,
            data: data ? JSON.stringify(data).substring(0, 200) : null
          };
          
          debugLogs.unshift(logEntry);
          if (debugLogs.length > 50) debugLogs.pop();
          
          localStorage.setItem('debugLogs', JSON.stringify(debugLogs));
          
          if (debugEnabled) {
            updateDebugPanel();
          }
        }
        
        function updateDebugPanel() {
          const debugContent = document.getElementById('debug-content');
          if (!debugContent) return;
          
          let html = debugLogs.map(log => \`
            <div class="debug-log">
              <div style="color: #81e6d9; font-size: 11px;">\${log.timestamp}</div>
              <div>\${log.message}</div>
              \${log.data ? \`<div style="color: #a0aec0; font-size: 10px;">\${log.data}</div>\` : ''}
            </div>
          \`).join('');
          
          debugContent.innerHTML = html;
        }
        
        function clearDebugLogs() {
          debugLogs = [];
          localStorage.setItem('debugLogs', JSON.stringify(debugLogs));
          updateDebugPanel();
        }
        
        function toggleDebug() {
          debugEnabled = !debugEnabled;
          localStorage.setItem('debugEnabled', debugEnabled);
          
          const debugPanel = document.getElementById('debug-panel');
          debugPanel.style.display = debugEnabled ? 'block' : 'none';
          
          if (debugEnabled) {
            updateDebugPanel();
          }
        }
        
        // 数据加载函数
        async function loadBackendStats() {
          addDebugLog('开始加载后端统计');
          
          const container = document.getElementById('backend-stats-container');
          const loadingHTML = \`
            <div class="loading-state">
              <div class="loading-spinner"></div>
              <p>正在加载后端服务器数据...</p>
            </div>
          \`;
          
          container.innerHTML = loadingHTML;
          
          try {
            const response = await fetch('/api/backend-stats?_t=' + Date.now());
            addDebugLog('后端统计响应状态', { status: response.status });
            
            if (!response.ok) {
              throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);
            }
            
            const data = await response.json();
            addDebugLog('后端统计数据接收', { count: data.length });
            
            if (!Array.isArray(data) || data.length === 0) {
              container.innerHTML = \`
                <div class="empty-state">
                  <i class="fas fa-server"></i>
                  <h3>暂无后端服务器</h3>
                  <p>请前往系统设置初始化数据库</p>
                  <button class="btn btn-primary" onclick="location.href='/init'" style="margin-top: 15px;">
                    <i class="fas fa-cog"></i> 前往设置
                  </button>
                </div>
              \`;
              return;
            }
            
            // 更新总数显示
            document.getElementById('total-backends').textContent = data.length;
            
            // 构建表格
            let html = \`
              <div class="stats-table-container">
                <table class="stats-table">
                  <thead>
                    <tr>
                      <th>后端地址</th>
                      <th>请求统计</th>
                      <th>性能指标</th>
                      <th>权重状态</th>
                    </tr>
                  </thead>
                  <tbody>
            \`;
            
            data.forEach(backend => {
              const totalRequests = backend.total_requests || 0;
              const successCount = backend.success_count || 0;
              const successRate = totalRequests > 0 
                ? ((successCount / totalRequests) * 100).toFixed(1) 
                : '0.0';
              const avgResponseTime = backend.average_response_time || 0;
              const dynamicWeight = backend.dynamic_weight || backend.weight || ${INITIAL_WEIGHT};
              
              html += \`
                <tr>
                  <td data-label="后端地址">
                    <div class="mobile-row">
                      <strong>\${backend.url || '未知'}</strong>
                      \${backend.enabled === 0 ? '<span class="status-badge status-failed" style="margin-left: 8px;">已禁用</span>' : ''}
                    </div>
                    <div style="max-width: 200px; overflow: hidden; text-overflow: ellipsis;">
                      \${backend.url || '未知'}
                    </div>
                    \${backend.enabled === 0 ? '<div><span class="status-badge status-failed">已禁用</span></div>' : ''}
                  </td>
                  <td data-label="请求统计">
                    <div style="margin-bottom: 4px;">
                      <small>总请求: \${totalRequests}</small>
                    </div>
                    <div style="margin-bottom: 4px;">
                      <small>成功: \${successCount} | 失败: \${backend.fail_count || 0}</small>
                    </div>
                    <div>
                      <small>成功率: \${successRate}%</small>
                    </div>
                    <div class="progress-container">
                      <div class="progress-bar" style="width: \${Math.min(successRate, 100)}%"></div>
                    </div>
                  </td>
                  <td data-label="性能指标">
                    <div style="margin-bottom: 4px;">
                      <small>平均响应: \${formatResponseTime(avgResponseTime)}</small>
                    </div>
                    <div>
                      <small>最后响应: \${formatResponseTime(backend.last_response_time || 0)}</small>
                    </div>
                  </td>
                  <td data-label="权重状态">
                    <div style="margin-bottom: 4px;">
                      <small>基础权重: \${backend.weight || ${INITIAL_WEIGHT}}</small>
                    </div>
                    <div style="margin-bottom: 4px;">
                      <small>动态权重: \${dynamicWeight.toFixed(1)}</small>
                    </div>
                    <div>
                      <small>最后使用: \${backend.last_used ? formatBeijingTime(backend.last_used) : '从未'}</small>
                    </div>
                  </td>
                </tr>
              \`;
            });
            
            html += '</tbody></table></div>';
            container.innerHTML = html;
            addDebugLog('后端统计表格渲染完成');
            
          } catch (error) {
            console.error('加载后端统计失败:', error);
            addDebugLog('加载后端统计失败', { error: error.message });
            
            container.innerHTML = \`
              <div class="error-state">
                <i class="fas fa-exclamation-triangle"></i>
                <h3>加载失败</h3>
                <p>\${error.message}</p>
                <button class="btn btn-primary" onclick="loadBackendStats()" style="margin-top: 15px;">
                  <i class="fas fa-redo"></i> 重新加载
                </button>
              </div>
            \`;
          }
        }
        
        async function loadRecentRequests() {
          addDebugLog('开始加载最近请求');
          
          const container = document.getElementById('recent-requests-container');
          const loadingHTML = \`
            <div class="loading-state">
              <div class="loading-spinner"></div>
              <p>正在加载请求记录...</p>
            </div>
          \`;
          
          container.innerHTML = loadingHTML;
          
          try {
            const response = await fetch('/api/recent-requests?_t=' + Date.now());
            addDebugLog('最近请求响应状态', { status: response.status });
            
            if (!response.ok) {
              throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);
            }
            
            const data = await response.json();
            addDebugLog('最近请求数据接收', { count: data.length });
            
            if (!Array.isArray(data) || data.length === 0) {
              container.innerHTML = \`
                <div class="empty-state">
                  <i class="fas fa-history"></i>
                  <h3>暂无请求记录</h3>
                  <p>系统尚未处理任何请求</p>
                </div>
              \`;
              return;
            }
            
            // 构建表格
            let html = \`
              <div class="stats-table-container">
                <table class="stats-table">
                  <thead>
                    <tr>
                      <th>后端地址</th>
                      <th>状态</th>
                      <th>响应时间</th>
                      <th>请求时间</th>
                    </tr>
                  </thead>
                  <tbody>
            \`;
            
            data.forEach(log => {
              const statusClass = log.status === 'success' ? 'status-success' : 'status-failed';
              const statusText = log.status === 'success' ? '成功' : '失败';
              
              html += \`
                <tr>
                  <td data-label="后端地址">
                    <div class="mobile-row">
                      \${log.backend_url || '未知'}
                    </div>
                    <div style="max-width: 180px; overflow: hidden; text-overflow: ellipsis;">
                      \${log.backend_url || '未知'}
                    </div>
                  </td>
                  <td data-label="状态">
                    <span class="status-badge \${statusClass}">\${statusText}</span>
                    \${log.error_message ? \`
                      <div style="margin-top: 4px;">
                        <small style="color: #718096; font-size: 11px;">
                          \${log.error_message.substring(0, 40)}\${log.error_message.length > 40 ? '...' : ''}
                        </small>
                      </div>
                    \` : ''}
                  </td>
                  <td data-label="响应时间">
                    \${formatResponseTime(log.response_time || 0)}
                  </td>
                  <td data-label="请求时间">
                    \${formatBeijingTime(log.request_time || new Date().toISOString())}
                  </td>
                </tr>
              \`;
            });
            
            html += '</tbody></table></div>';
            container.innerHTML = html;
            addDebugLog('最近请求表格渲染完成');
            
          } catch (error) {
            console.error('加载最近请求失败:', error);
            addDebugLog('加载最近请求失败', { error: error.message });
            
            container.innerHTML = \`
              <div class="error-state">
                <i class="fas fa-exclamation-triangle"></i>
                <h3>加载失败</h3>
                <p>\${error.message}</p>
                <button class="btn btn-primary" onclick="loadRecentRequests()" style="margin-top: 15px;">
                  <i class="fas fa-redo"></i> 重新加载
                </button>
              </div>
            \`;
          }
        }
        
        // 刷新所有数据
        function refreshData() {
          addDebugLog('手动刷新数据');
          document.getElementById('last-update-time').textContent = formatBeijingTime(new Date().toISOString());
          loadBackendStats();
          loadRecentRequests();
        }
        
        // 页面初始化
        document.addEventListener('DOMContentLoaded', () => {
          addDebugLog('页面加载完成');
          
          // 初始化调试面板
          if (debugEnabled) {
            document.getElementById('debug-panel').style.display = 'block';
            updateDebugPanel();
          }
          
          // 设置最后更新时间
          document.getElementById('last-update-time').textContent = formatBeijingTime(new Date().toISOString());
          
          // 如果初始数据为空，则从API加载
          if (${backendStats.length} === 0) {
            loadBackendStats();
          }
          
          if (${recentRequests.length} === 0) {
            loadRecentRequests();
          }
          
          // 每120秒自动刷新（修改为120秒）
          setInterval(refreshData, 120000);
          
          // 监听页面可见性变化
          document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
              addDebugLog('页面变为可见，刷新数据');
              refreshData();
            }
          });
        });
        
        // 添加键盘快捷键
        document.addEventListener('keydown', (e) => {
          // Ctrl + R 刷新
          if (e.ctrlKey && e.key === 'r') {
            e.preventDefault();
            refreshData();
            addDebugLog('使用快捷键刷新数据');
          }
          
          // Ctrl + D 切换调试
          if (e.ctrlKey && e.key === 'd') {
            e.preventDefault();
            toggleDebug();
          }
        });
      </script>
    </body>
    </html>
  `;
  
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
    }
  });
}

// 辅助函数：在HTML模板中使用的格式化函数
function formatResponseTimeForHTML(ms) {
  if (!ms || ms < 0) return '0ms';
  if (ms < 1000) return ms.toFixed(0) + 'ms';
  return (ms / 1000).toFixed(2) + 's';
}

function formatBeijingTimeForHTML(isoString) {
  if (!isoString) return '从未';
  try {
    const date = new Date(isoString);
    const beijingTime = new Date(date.getTime());
    return beijingTime.toLocaleString('zh-CN', { 
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch (e) {
    return isoString;
  }
}

// 初始化页面
async function handleInitPage(request, env) {
  logInfo('处理初始化页面请求');
  
  // 确保数据库表存在
  await ensureDatabaseInitialized(env);
  
  // 检查是否有后端数据
  const result = await env.DB.prepare('SELECT COUNT(*) as count FROM backend_servers').first();
  const hasBackends = result && result.count > 0;
  const backendCount = result?.count || 0;
  
  logInfo(`初始化页面状态: 有后端数据 = ${hasBackends}, 数量 = ${backendCount}`);
  
  const html = `
    <!DOCTYPE html>
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
          --card-bg: rgba(255, 255, 255, 0.95);
          --text-primary: #2d3748;
          --text-secondary: #718096;
          --border-color: #e2e8f0;
          --shadow-lg: 0 20px 40px rgba(0, 0, 0, 0.1);
          --radius-lg: 20px;
        }
        
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          color: var(--text-primary);
          line-height: 1.6;
        }
        
        .init-container {
          background: var(--card-bg);
          border-radius: var(--radius-lg);
          padding: 50px;
          max-width: 700px;
          width: 100%;
          box-shadow: var(--shadow-lg);
          backdrop-filter: blur(10px);
          border: 1px solid rgba(255, 255, 255, 0.2);
          text-align: center;
          animation: slideIn 0.6s ease-out;
        }
        
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateY(30px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        
        .header {
          margin-bottom: 40px;
        }
        
        .header-icon {
          width: 80px;
          height: 80px;
          background: var(--primary-gradient);
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0 auto 20px;
          color: white;
          font-size: 32px;
          box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
        }
        
        h1 {
          font-size: 32px;
          font-weight: 700;
          background: var(--primary-gradient);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          margin-bottom: 12px;
        }
        
        .subtitle {
          color: var(--text-secondary);
          font-size: 16px;
          max-width: 500px;
          margin: 0 auto;
        }
        
        .status-card {
          background: linear-gradient(135deg, #f8fafc 0%, #edf2f7 100%);
          border-radius: 16px;
          padding: 30px;
          margin: 30px 0;
          text-align: left;
          border: 1px solid var(--border-color);
        }
        
        .status-card h2 {
          color: var(--text-primary);
          margin-bottom: 25px;
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 20px;
          font-weight: 600;
        }
        
        .status-card h2 i {
          width: 36px;
          height: 36px;
          background: var(--primary-gradient);
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
          font-size: 16px;
        }
        
        .status-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 20px;
        }
        
        .status-item {
          padding: 20px;
          background: white;
          border-radius: 12px;
          border: 1px solid var(--border-color);
          transition: transform 0.3s ease, box-shadow 0.3s ease;
        }
        
        .status-item:hover {
          transform: translateY(-3px);
          box-shadow: 0 10px 20px rgba(0, 0, 0, 0.1);
        }
        
        .status-label {
          color: var(--text-secondary);
          font-size: 14px;
          font-weight: 500;
          margin-bottom: 8px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        
        .status-value {
          color: var(--text-primary);
          font-size: 24px;
          font-weight: 700;
          margin-bottom: 4px;
        }
        
        .status-value.success {
          color: #38a169;
        }
        
        .status-value.warning {
          color: #d69e2e;
        }
        
        .status-value.error {
          color: #e53e3e;
        }
        
        .status-hint {
          color: var(--text-secondary);
          font-size: 13px;
        }
        
        .backend-list {
          background: white;
          border-radius: 12px;
          padding: 25px;
          margin: 30px 0;
          border: 1px solid var(--border-color);
          max-height: 300px;
          overflow-y: auto;
        }
        
        .backend-list h3 {
          color: var(--text-primary);
          margin-bottom: 20px;
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 18px;
          font-weight: 600;
        }
        
        .backend-list h3 i {
          color: #667eea;
        }
        
        .backend-url {
          padding: 12px 15px;
          background: #f7fafc;
          border-radius: 8px;
          margin-bottom: 10px;
          display: flex;
          align-items: center;
          gap: 12px;
          transition: background 0.3s ease;
        }
        
        .backend-url:hover {
          background: #edf2f7;
        }
        
        .backend-url i {
          color: #667eea;
          font-size: 14px;
          min-width: 20px;
        }
        
        .backend-url span {
          color: var(--text-primary);
          font-size: 14px;
          word-break: break-all;
        }
        
        .message {
          padding: 20px;
          border-radius: 12px;
          margin: 25px 0;
          display: none;
          animation: fadeIn 0.5s ease;
          text-align: left;
        }
        
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        
        .message.success {
          background: linear-gradient(135deg, #c6f6d5 0%, #9ae6b4 100%);
          color: #22543d;
          border: 1px solid #9ae6b4;
          display: block;
        }
        
        .message.error {
          background: linear-gradient(135deg, #fed7d7 0%, #feb2b2 100%);
          color: #742a2a;
          border: 1px solid #feb2b2;
          display: block;
        }
        
        .message-content {
          display: flex;
          align-items: center;
          gap: 15px;
        }
        
        .message-icon {
          font-size: 24px;
          flex-shrink: 0;
        }
        
        .btn-group {
          display: flex;
          flex-direction: column;
          gap: 15px;
          margin-top: 30px;
        }
        
        .btn {
          padding: 18px 30px;
          border: none;
          border-radius: 12px;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s ease;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          text-decoration: none;
          width: 100%;
        }
        
        .btn-primary {
          background: var(--primary-gradient);
          color: white;
          box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
        }
        
        .btn-primary:hover:not(:disabled) {
          transform: translateY(-3px);
          box-shadow: 0 8px 25px rgba(102, 126, 234, 0.5);
        }
        
        .btn-primary:disabled {
          opacity: 0.7;
          cursor: not-allowed;
          transform: none !important;
        }
        
        .btn-secondary {
          background: white;
          color: var(--text-primary);
          border: 2px solid var(--border-color);
        }
        
        .btn-secondary:hover {
          background: #f7fafc;
          transform: translateY(-3px);
          box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
        }
        
        .btn-warning {
          background: var(--warning-gradient);
          color: white;
          box-shadow: 0 4px 15px rgba(245, 87, 108, 0.4);
        }
        
        .btn-warning:hover {
          transform: translateY(-3px);
          box-shadow: 0 8px 25px rgba(245, 87, 108, 0.5);
        }
        
        .spinner {
          animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        
        @media (max-width: 768px) {
          .init-container {
            padding: 30px 20px;
          }
          
          h1 {
            font-size: 26px;
          }
          
          .header-icon {
            width: 60px;
            height: 60px;
            font-size: 24px;
          }
          
          .status-grid {
            grid-template-columns: 1fr;
          }
          
          .btn {
            padding: 16px 20px;
            font-size: 15px;
          }
        }
        
        @media (prefers-color-scheme: dark) {
          :root {
            --card-bg: rgba(45, 55, 72, 0.95);
            --text-primary: #f7fafc;
            --text-secondary: #a0aec0;
            --border-color: #4a5568;
          }
          
          body {
            background: linear-gradient(135deg, #1a202c 0%, #2d3748 100%);
          }
          
          .status-card {
            background: linear-gradient(135deg, #2d3748 0%, #4a5568 100%);
          }
          
          .status-item {
            background: #2d3748;
          }
          
          .backend-list {
            background: #2d3748;
          }
          
          .backend-url {
            background: #4a5568;
          }
          
          .backend-url:hover {
            background: #5a6778;
          }
          
          .btn-secondary {
            background: #4a5568;
            color: #f7fafc;
          }
          
          .btn-secondary:hover {
            background: #5a6778;
          }
        }
      </style>
    </head>
    <body>
      <div class="init-container">
        <div class="header">
          <div class="header-icon">
            <i class="fas fa-database"></i>
          </div>
          <h1>数据库初始化</h1>
          <p class="subtitle">订阅转换负载均衡系统的数据库配置与管理</p>
        </div>
        
        <div class="status-card">
          <h2><i class="fas fa-info-circle"></i> 当前系统状态</h2>
          <div class="status-grid">
            <div class="status-item">
              <div class="status-label">
                <i class="fas fa-table"></i> 数据库表状态
              </div>
              <div class="status-value success">已就绪</div>
              <div class="status-hint">后端表和日志表已创建</div>
            </div>
            
            <div class="status-item">
              <div class="status-label">
                <i class="fas fa-server"></i> 后端服务器
              </div>
              <div class="status-value ${hasBackends ? 'success' : 'warning'}">
                ${hasBackends ? `已配置 (${backendCount}个)` : '未配置'}
              </div>
              <div class="status-hint">
                ${hasBackends ? '系统已准备就绪' : '需要初始化后端服务器'}
              </div>
            </div>
            
            <div class="status-item">
              <div class="status-label">
                <i class="fas fa-cogs"></i> 默认配置
              </div>
              <div class="status-value">${DEFAULT_BACKENDS.length} 个</div>
              <div class="status-hint">预设后端服务器地址</div>
            </div>
          </div>
        </div>
        
        <div class="backend-list">
          <h3><i class="fas fa-list"></i> 默认后端服务器列表</h3>
          ${DEFAULT_BACKENDS.map(url => `
            <div class="backend-url">
              <i class="fas fa-link"></i>
              <span>${url}</span>
            </div>
          `).join('')}
        </div>
        
        <div id="message" class="message"></div>
        
        <div class="btn-group">
          ${!hasBackends ? `
            <button id="init-btn" class="btn btn-primary" onclick="initializeDatabase()">
              <i class="fas fa-play-circle"></i> 初始化数据库（添加默认后端）
            </button>
            <button class="btn btn-secondary" onclick="location.href='/status'">
              <i class="fas fa-arrow-left"></i> 返回状态页面
            </button>
          ` : `
            <button class="btn btn-primary" onclick="location.href='/status'">
              <i class="fas fa-chart-bar"></i> 前往状态监控面板
            </button>
            <button class="btn btn-warning" onclick="showResetConfirm()">
              <i class="fas fa-redo"></i> 重置数据库
            </button>
            <button class="btn btn-secondary" onclick="location.href='/'">
              <i class="fas fa-home"></i> 返回首页
            </button>
          `}
        </div>
      </div>
      
      <script>
        function showMessage(text, type, icon = 'info-circle') {
          const messageDiv = document.getElementById('message');
          messageDiv.className = 'message ' + type;
          messageDiv.innerHTML = \`
            <div class="message-content">
              <div class="message-icon">
                <i class="fas fa-\${icon}"></i>
              </div>
              <div>\${text}</div>
            </div>
          \`;
          messageDiv.style.display = 'block';
          
          // 自动隐藏成功消息
          if (type === 'success') {
            setTimeout(() => {
              messageDiv.style.display = 'none';
            }, 5000);
          }
        }
        
        async function initializeDatabase() {
          const btn = document.getElementById('init-btn');
          const originalHtml = btn.innerHTML;
          
          btn.disabled = true;
          btn.innerHTML = '<i class="fas fa-spinner spinner"></i> 正在初始化...';
          
          try {
            showMessage('正在初始化数据库，请稍候...', 'success', 'spinner');
            
            const response = await fetch('/api/init-db', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              }
            });
            
            const result = await response.json();
            
            if (result.success) {
              showMessage(
                \`<strong>数据库初始化成功！</strong><br>
                成功添加了 \${result.backends_added} 个后端服务器。\${result.errors.length > 0 ? ' (' + result.errors.length + '个失败)' : ''}<br>
                页面将在 3 秒后自动跳转...\`,
                'success',
                'check-circle'
              );
              
              setTimeout(() => {
                location.href = '/status';
              }, 3000);
            } else {
              showMessage(
                \`<strong>初始化失败！</strong><br>
                错误信息: \${result.error || '未知错误'}\`,
                'error',
                'times-circle'
              );
              btn.disabled = false;
              btn.innerHTML = originalHtml;
            }
          } catch (error) {
            showMessage(
              \`<strong>请求失败！</strong><br>
              网络错误: \${error.message}\`,
              'error',
              'times-circle'
            );
            btn.disabled = false;
            btn.innerHTML = originalHtml;
          }
        }
        
        function showResetConfirm() {
          const confirmHTML = \`
            <div style="text-align: left; margin-bottom: 20px;">
              <h3 style="margin-bottom: 10px; color: #e53e3e;">
                <i class="fas fa-exclamation-triangle"></i> 确认重置数据库
              </h3>
              <p style="color: var(--text-secondary); line-height: 1.5;">
                此操作将删除所有现有数据，包括：
              </p>
              <ul style="color: var(--text-secondary); margin: 10px 0 10px 20px;">
                <li>所有后端服务器配置</li>
                <li>所有请求历史记录</li>
                <li>所有性能统计数据</li>
              </ul>
              <p style="color: var(--text-secondary);">
                重置后系统将恢复到默认配置。
              </p>
            </div>
          \`;
          
          if (confirm(confirmHTML.replace(/<[^>]*>/g, ''))) {
            resetDatabase();
          }
        }
        
        async function resetDatabase() {
          try {
            showMessage('正在重置数据库，请稍候...', 'success', 'spinner');
            
            const response = await fetch('/api/init-db', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              }
            });
            
            const result = await response.json();
            
            if (result.success) {
              showMessage(
                \`<strong>数据库重置成功！</strong><br>
                已重新添加 \${result.backends_added} 个后端服务器。<br>
                页面将在 2 秒后刷新...\`,
                'success',
                'check-circle'
              );
              
              setTimeout(() => {
                location.reload();
              }, 2000);
            } else {
              showMessage(
                \`<strong>重置失败！</strong><br>
                错误信息: \${result.error || '未知错误'}\`,
                'error',
                'times-circle'
              );
            }
          } catch (error) {
            showMessage(
              \`<strong>请求失败！</strong><br>
              网络错误: \${error.message}\`,
              'error',
              'times-circle'
            );
          }
        }
        
        // 添加键盘快捷键
        document.addEventListener('keydown', (e) => {
          // Enter 键触发初始化（如果按钮可用）
          if (e.key === 'Enter' && ${!hasBackends}) {
            const initBtn = document.getElementById('init-btn');
            if (initBtn && !initBtn.disabled) {
              initializeDatabase();
            }
          }
          
          // Escape 键返回状态页面
          if (e.key === 'Escape') {
            location.href = '/status';
          }
        });
        
        // 页面加载完成动画
        document.addEventListener('DOMContentLoaded', () => {
          const statusItems = document.querySelectorAll('.status-item');
          statusItems.forEach((item, index) => {
            item.style.animationDelay = \`\${index * 0.1}s\`;
            item.style.animation = 'slideIn 0.5s ease-out forwards';
          });
        });
      </script>
    </body>
    </html>
  `;
  
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
    }
  });
}

// API: 初始化数据库
async function handleInitDatabase(request, env) {
  logInfo('处理数据库初始化API请求');
  if (request.method !== 'POST') {
    logError('数据库初始化请求方法不正确', { method: request.method });
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  
  try {
    // 确保表存在
    await ensureDatabaseInitialized(env);
    
    // 清空现有数据
    logDebug('清空现有数据');
    await env.DB.prepare('DELETE FROM backend_servers').run();
    await env.DB.prepare('DELETE FROM request_logs').run();
    
    // 插入默认后端地址
    let inserted = 0;
    let errors = [];
    
    logInfo(`开始插入默认后端地址 (共${DEFAULT_BACKENDS.length}个)`);
    for (const url of DEFAULT_BACKENDS) {
      try {
        await env.DB.prepare(`
          INSERT INTO backend_servers (url, weight, dynamic_weight)
          VALUES (?, ?, ?)
        `).bind(url, INITIAL_WEIGHT, INITIAL_WEIGHT).run();
        inserted++;
        logDebug(`插入后端成功: ${url}`);
      } catch (error) {
        logError(`插入后端失败: ${url}`, error);
        errors.push({ url, error: error.message });
        // 继续插入其他后端
      }
    }
    
    logInfo(`数据库初始化完成: 成功插入${inserted}个后端, 失败${errors.length}个`);
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Database initialized successfully',
      backends_added: inserted,
      errors: errors,
      total_backends: DEFAULT_BACKENDS.length
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
    
  } catch (error) {
    logError('数据库初始化错误', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      stack: error.stack
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}