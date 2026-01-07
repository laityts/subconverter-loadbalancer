// Cloudflare Worker 主文件
// 订阅转换负载均衡系统

// 北京时区格式化
const BEIJING_TIMEZONE = 'Asia/Shanghai';

// 默认后端地址
const DEFAULT_BACKENDS = [
  'https://api.wcc.best',
  'https://www.nameless13.com',
  'https://subapi.cmliussss.net',
  'https://sub.xeton.dev',
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
  
  const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>订阅转换负载均衡 - 状态监控</title>
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          padding: 20px;
        }
        
        .container {
          max-width: 1200px;
          margin: 0 auto;
        }
        
        .header {
          background: white;
          border-radius: 10px;
          padding: 30px;
          margin-bottom: 20px;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        
        h1 {
          color: #333;
          margin-bottom: 10px;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        
        h1 i {
          color: #667eea;
        }
        
        .subtitle {
          color: #666;
          font-size: 16px;
        }
        
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
          gap: 20px;
          margin-bottom: 20px;
        }
        
        .card {
          background: white;
          border-radius: 10px;
          padding: 20px;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        
        .card h2 {
          color: #444;
          margin-bottom: 20px;
          padding-bottom: 10px;
          border-bottom: 2px solid #f0f0f0;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        
        .card h2 i {
          color: #667eea;
        }
        
        .stats-table {
          width: 100%;
          border-collapse: collapse;
        }
        
        .stats-table th {
          background: #f8f9fa;
          color: #495057;
          font-weight: 600;
          text-align: left;
          padding: 12px;
          border-bottom: 2px solid #dee2e6;
        }
        
        .stats-table td {
          padding: 12px;
          border-bottom: 1px solid #dee2e6;
        }
        
        .stats-table tr:hover {
          background: #f8f9fa;
        }
        
        .status-badge {
          padding: 4px 8px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
        }
        
        .status-success {
          background: #d4edda;
          color: #155724;
        }
        
        .status-failed {
          background: #f8d7da;
          color: #721c24;
        }
        
        .progress-bar {
          width: 100%;
          height: 6px;
          background: #e9ecef;
          border-radius: 3px;
          overflow: hidden;
          margin-top: 5px;
        }
        
        .progress-fill {
          height: 100%;
          background: #28a745;
          transition: width 0.3s ease;
        }
        
        .actions {
          display: flex;
          gap: 10px;
          margin-top: 20px;
        }
        
        .btn {
          padding: 10px 20px;
          border: none;
          border-radius: 5px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s ease;
          display: flex;
          align-items: center;
          gap: 5px;
        }
        
        .btn-primary {
          background: #667eea;
          color: white;
        }
        
        .btn-primary:hover {
          background: #5a67d8;
          transform: translateY(-2px);
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        
        .btn-secondary {
          background: #6c757d;
          color: white;
        }
        
        .btn-secondary:hover {
          background: #5a6268;
          transform: translateY(-2px);
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        
        .loading {
          text-align: center;
          padding: 40px;
          color: #666;
        }
        
        .loading i {
          animation: spin 1s linear infinite;
        }
        
        .empty-state {
          text-align: center;
          padding: 40px;
          color: #666;
        }
        
        .error-state {
          text-align: center;
          padding: 40px;
          color: #dc3545;
          background: #f8d7da;
          border-radius: 8px;
          margin: 10px 0;
        }
        
        .debug-info {
          background: #f8f9fa;
          border-radius: 8px;
          padding: 15px;
          margin-top: 20px;
          font-size: 12px;
          color: #666;
          max-height: 200px;
          overflow-y: auto;
        }
        
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        
        @media (max-width: 768px) {
          .stats-grid {
            grid-template-columns: 1fr;
          }
          
          .header {
            padding: 20px;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1><i class="fas fa-balance-scale"></i> 订阅转换负载均衡系统</h1>
          <p class="subtitle">智能加权轮询 | 实时监控 | 性能统计</p>
          <div class="actions">
            <button class="btn btn-primary" onclick="refreshData()">
              <i class="fas fa-sync-alt"></i> 刷新数据
            </button>
            <button class="btn btn-secondary" onclick="location.href='/init'">
              <i class="fas fa-database"></i> 数据库管理
            </button>
            <button class="btn btn-secondary" onclick="toggleDebug()">
              <i class="fas fa-bug"></i> 调试信息
            </button>
          </div>
          <div id="debug-info" class="debug-info" style="display: none;">
            <h4><i class="fas fa-bug"></i> 调试信息</h4>
            <div id="debug-content">加载中...</div>
          </div>
        </div>
        
        <div class="stats-grid">
          <div class="card">
            <h2><i class="fas fa-history"></i> 最近请求</h2>
            <div id="recent-requests" class="loading">
              <i class="fas fa-spinner"></i> 加载中...
            </div>
          </div>
          
          <div class="card">
            <h2><i class="fas fa-server"></i> 后端服务器状态</h2>
            <div id="backend-stats" class="loading">
              <i class="fas fa-spinner"></i> 加载中...
            </div>
          </div>
        </div>
      </div>
      
      <script>
        // 常量定义
        const INITIAL_WEIGHT = ${INITIAL_WEIGHT};
        const SUCCESS_WEIGHT_INCREMENT = ${SUCCESS_WEIGHT_INCREMENT};
        const FAILURE_WEIGHT_DECREMENT = ${FAILURE_WEIGHT_DECREMENT};
        const MAX_WEIGHT = ${MAX_WEIGHT};
        const MIN_WEIGHT = ${MIN_WEIGHT};
        
        // 调试信息
        let debugEnabled = false;
        const debugLogs = [];
        
        function addDebugLog(message, data = null) {
          const timestamp = new Date().toLocaleString('zh-CN');
          const logEntry = {
            timestamp,
            message,
            data
          };
          debugLogs.unshift(logEntry); // 添加到开头
          if (debugLogs.length > 20) debugLogs.pop(); // 限制数量
          
          if (debugEnabled) {
            updateDebugDisplay();
          }
        }
        
        function updateDebugDisplay() {
          const debugContent = document.getElementById('debug-content');
          if (!debugContent) return;
          
          let html = '';
          debugLogs.forEach(log => {
            html += \`<div style="margin-bottom: 5px; border-bottom: 1px dashed #ddd; padding-bottom: 5px;">
              <strong>\${log.timestamp}</strong>: \${log.message}
              \${log.data ? '<br><small style="color: #888;">' + JSON.stringify(log.data) + '</small>' : ''}
            </div>\`;
          });
          debugContent.innerHTML = html;
        }
        
        function toggleDebug() {
          debugEnabled = !debugEnabled;
          const debugInfo = document.getElementById('debug-info');
          debugInfo.style.display = debugEnabled ? 'block' : 'none';
          if (debugEnabled) {
            updateDebugDisplay();
          }
        }
        
        // 格式化时间为北京时间
        function formatBeijingTime(isoString) {
          if (!isoString) return 'N/A';
          try {
            const date = new Date(isoString);
            // 转换为北京时间 (UTC+8)
            const beijingTime = new Date(date.getTime());
            return beijingTime.toLocaleString('zh-CN', { 
              timeZone: 'Asia/Shanghai',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            });
          } catch (e) {
            addDebugLog('时间格式化错误', { isoString, error: e.message });
            return isoString || 'N/A';
          }
        }
        
        // 格式化响应时间
        function formatResponseTime(ms) {
          if (ms === null || ms === undefined || isNaN(ms)) return '0ms';
          if (ms < 1000) return ms.toFixed(0) + 'ms';
          return (ms / 1000).toFixed(2) + 's';
        }
        
        // 加载最近请求数据
        async function loadRecentRequests() {
          addDebugLog('开始加载最近请求');
          try {
            const response = await fetch('/api/recent-requests');
            addDebugLog('收到最近请求响应', { status: response.status });
            
            if (!response.ok) {
              throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);
            }
            
            const data = await response.json();
            addDebugLog('最近请求数据解析成功', { count: data.length });
            
            const container = document.getElementById('recent-requests');
            if (!data || !Array.isArray(data) || data.length === 0) {
              container.innerHTML = '<div class="empty-state">暂无请求记录</div>';
              return;
            }
            
            let html = \`
              <table class="stats-table">
                <thead>
                  <tr>
                    <th>后端地址</th>
                    <th>状态</th>
                    <th>响应时间</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
            \`;
            
            data.forEach(item => {
              html += \`
                <tr>
                  <td style="max-width: 200px; word-break: break-all;">
                    <small>\${item.backend_url || 'N/A'}</small>
                  </td>
                  <td>
                    <span class="status-badge \${(item.status || '') === 'success' ? 'status-success' : 'status-failed'}">
                      \${(item.status || '') === 'success' ? '成功' : '失败'}
                    </span>
                    \${item.error_message ? '<br><small style="color: #666;">' + item.error_message.substring(0, 50) + (item.error_message.length > 50 ? '...' : '') + '</small>' : ''}
                  </td>
                  <td>\${formatResponseTime(item.response_time)}</td>
                  <td>\${formatBeijingTime(item.request_time)}</td>
                </tr>
              \`;
            });
            
            html += '</tbody></table>';
            container.innerHTML = html;
            
          } catch (error) {
            console.error('加载最近请求失败:', error);
            addDebugLog('加载最近请求失败', { error: error.message });
            document.getElementById('recent-requests').innerHTML = 
              \`<div class="error-state">
                <i class="fas fa-exclamation-triangle"></i> 加载失败<br>
                <small>\${error.message}</small>
                <button class="btn btn-primary" onclick="loadRecentRequests()" style="margin-top: 10px; font-size: 12px;">
                  <i class="fas fa-redo"></i> 重试
                </button>
              </div>\`;
          }
        }
        
        // 加载后端统计
        async function loadBackendStats() {
          addDebugLog('开始加载后端统计');
          try {
            const response = await fetch('/api/backend-stats');
            addDebugLog('收到后端统计响应', { status: response.status });
            
            if (!response.ok) {
              throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);
            }
            
            const data = await response.json();
            addDebugLog('后端统计数据解析成功', { count: data.length });
            
            const container = document.getElementById('backend-stats');
            if (!data || !Array.isArray(data) || data.length === 0) {
              container.innerHTML = '<div class="empty-state">暂无后端服务器<br><button class="btn btn-primary" onclick="location.href=\'/init\'" style="margin-top: 10px;">初始化数据库</button></div>';
              return;
            }
            
            let html = \`
              <table class="stats-table">
                <thead>
                  <tr>
                    <th>后端地址</th>
                    <th>统计</th>
                    <th>响应时间</th>
                    <th>权重</th>
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
              
              html += \`
                <tr>
                  <td style="max-width: 150px; word-break: break-all;">
                    <small>\${backend.url || 'N/A'}</small>
                    \${backend.enabled === 0 ? '<br><small style="color: #dc3545;">已禁用</small>' : ''}
                  </td>
                  <td>
                    <div>请求: \${totalRequests}</div>
                    <div>成功: \${successCount} | 失败: \${backend.fail_count || 0}</div>
                    <div>成功率: \${successRate}%</div>
                    <div class="progress-bar">
                      <div class="progress-fill" style="width: \${Math.min(successRate, 100)}%"></div>
                    </div>
                  </td>
                  <td>
                    <div>平均: \${formatResponseTime(backend.average_response_time)}</div>
                    <small>最后: \${formatResponseTime(backend.last_response_time)}</small>
                  </td>
                  <td>
                    <div>基础权重: \${backend.weight || INITIAL_WEIGHT}</div>
                    <div>动态权重: \${(backend.dynamic_weight || backend.weight || INITIAL_WEIGHT).toFixed(1)}</div>
                    <div>最后使用: \${backend.last_used ? formatBeijingTime(backend.last_used) : '从未'}</div>
                  </td>
                </tr>
              \`;
            });
            
            html += '</tbody></table>';
            container.innerHTML = html;
            
          } catch (error) {
            console.error('加载后端统计失败:', error);
            addDebugLog('加载后端统计失败', { error: error.message });
            document.getElementById('backend-stats').innerHTML = 
              \`<div class="error-state">
                <i class="fas fa-exclamation-triangle"></i> 加载失败<br>
                <small>\${error.message}</small>
                <button class="btn btn-primary" onclick="loadBackendStats()" style="margin-top: 10px; font-size: 12px;">
                  <i class="fas fa-redo"></i> 重试
                </button>
              </div>\`;
          }
        }
        
        // 刷新数据
        function refreshData() {
          addDebugLog('手动刷新数据');
          const loadingHTML = '<div class="loading"><i class="fas fa-spinner"></i> 加载中...</div>';
          document.getElementById('recent-requests').innerHTML = loadingHTML;
          document.getElementById('backend-stats').innerHTML = loadingHTML;
          
          loadRecentRequests();
          loadBackendStats();
        }
        
        // 测试API连接
        async function testAPIConnection() {
          addDebugLog('测试API连接');
          try {
            const testUrls = ['/api/backend-stats', '/api/recent-requests'];
            for (const url of testUrls) {
              const response = await fetch(url);
              addDebugLog(\`测试 \${url}\`, { status: response.status, ok: response.ok });
            }
          } catch (error) {
            addDebugLog('API连接测试失败', { error: error.message });
          }
        }
        
        // 页面加载时获取数据
        document.addEventListener('DOMContentLoaded', () => {
          addDebugLog('页面加载完成');
          loadRecentRequests();
          loadBackendStats();
          testAPIConnection();
          
          // 每30秒自动刷新
          setInterval(refreshData, 30000);
          
          // 检查是否有错误参数
          const urlParams = new URLSearchParams(window.location.search);
          if (urlParams.has('debug')) {
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

// 初始化页面
async function handleInitPage(request, env) {
  logInfo('处理初始化页面请求');
  
  // 确保数据库表存在
  await ensureDatabaseInitialized(env);
  
  // 检查是否有后端数据
  const result = await env.DB.prepare('SELECT COUNT(*) as count FROM backend_servers').first();
  const hasBackends = result && result.count > 0;
  
  logInfo(`初始化页面状态: 有后端数据 = ${hasBackends}, 数量 = ${result?.count || 0}`);
  
  const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>数据库初始化</title>
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        
        .init-container {
          background: white;
          border-radius: 15px;
          padding: 40px;
          max-width: 600px;
          width: 100%;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
          text-align: center;
        }
        
        h1 {
          color: #333;
          margin-bottom: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 15px;
        }
        
        h1 i {
          color: #667eea;
          font-size: 2em;
        }
        
        .status-card {
          background: #f8f9fa;
          border-radius: 10px;
          padding: 25px;
          margin: 25px 0;
          text-align: left;
        }
        
        .status-card h2 {
          color: #495057;
          margin-bottom: 15px;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        
        .status-item {
          display: flex;
          justify-content: space-between;
          padding: 10px 0;
          border-bottom: 1px solid #e9ecef;
        }
        
        .status-item:last-child {
          border-bottom: none;
        }
        
        .status-label {
          color: #666;
          font-weight: 500;
        }
        
        .status-value {
          color: #333;
          font-weight: 600;
        }
        
        .status-value.success {
          color: #28a745;
        }
        
        .status-value.error {
          color: #dc3545;
        }
        
        .btn {
          padding: 15px 30px;
          border: none;
          border-radius: 8px;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s ease;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          width: 100%;
          margin-top: 20px;
        }
        
        .btn-primary {
          background: #667eea;
          color: white;
        }
        
        .btn-primary:hover {
          background: #5a67d8;
          transform: translateY(-2px);
          box-shadow: 0 10px 20px rgba(0, 0, 0, 0.2);
        }
        
        .btn-primary:disabled {
          background: #6c757d;
          cursor: not-allowed;
          transform: none;
          box-shadow: none;
        }
        
        .btn-secondary {
          background: #6c757d;
          color: white;
        }
        
        .btn-secondary:hover {
          background: #5a6268;
          transform: translateY(-2px);
          box-shadow: 0 10px 20px rgba(0, 0, 0, 0.1);
        }
        
        .message {
          padding: 15px;
          border-radius: 8px;
          margin: 20px 0;
          display: none;
        }
        
        .message.success {
          background: #d4edda;
          color: #155724;
          border: 1px solid #c3e6cb;
          display: block;
        }
        
        .message.error {
          background: #f8d7da;
          color: #721c24;
          border: 1px solid #f5c6cb;
          display: block;
        }
        
        .default-backends {
          background: #e9ecef;
          border-radius: 8px;
          padding: 15px;
          margin: 20px 0;
          text-align: left;
          max-height: 200px;
          overflow-y: auto;
        }
        
        .default-backends h3 {
          margin-bottom: 10px;
          color: #495057;
        }
        
        .backend-url {
          padding: 5px 0;
          color: #666;
          font-size: 14px;
          border-bottom: 1px dashed #dee2e6;
        }
        
        .backend-url:last-child {
          border-bottom: none;
        }
        
        @media (max-width: 768px) {
          .init-container {
            padding: 20px;
          }
        }
      </style>
    </head>
    <body>
      <div class="init-container">
        <h1><i class="fas fa-database"></i> 数据库初始化</h1>
        
        <div class="status-card">
          <h2><i class="fas fa-info-circle"></i> 当前状态</h2>
          <div class="status-item">
            <span class="status-label">数据库表:</span>
            <span id="db-status" class="status-value success">
              已创建
            </span>
          </div>
          <div class="status-item">
            <span class="status-label">后端服务器:</span>
            <span id="backend-count" class="status-value ${hasBackends ? 'success' : 'error'}">
              ${hasBackends ? `已配置 (${result.count}个)` : '未配置'}
            </span>
          </div>
        </div>
        
        <div class="default-backends">
          <h3><i class="fas fa-server"></i> 默认后端服务器 (${DEFAULT_BACKENDS.length}个)</h3>
          ${DEFAULT_BACKENDS.map(url => `<div class="backend-url">${url}</div>`).join('')}
        </div>
        
        <div id="message" class="message"></div>
        
        ${!hasBackends ? `
          <button id="init-btn" class="btn btn-primary" onclick="initializeDatabase()">
            <i class="fas fa-play-circle"></i> 初始化数据库（添加默认后端）
          </button>
        ` : `
          <button class="btn btn-primary" onclick="location.href='/status'">
            <i class="fas fa-chart-bar"></i> 前往状态页面
          </button>
          <button class="btn btn-secondary" onclick="resetDatabase()" style="margin-top: 10px;">
            <i class="fas fa-redo"></i> 重置数据库
          </button>
        `}
      </div>
      
      <script>
        function showMessage(text, type) {
          const messageDiv = document.getElementById('message');
          messageDiv.className = 'message ' + type;
          messageDiv.innerHTML = text;
          messageDiv.style.display = 'block';
          
          if (type === 'success') {
            setTimeout(() => {
              location.href = '/status';
            }, 2000);
          }
        }
        
        async function initializeDatabase() {
          const btn = document.getElementById('init-btn');
          btn.disabled = true;
          btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 初始化中...';
          
          try {
            const response = await fetch('/api/init-db', {
              method: 'POST'
            });
            
            const result = await response.json();
            console.log('初始化结果:', result);
            
            if (result.success) {
              showMessage('<i class="fas fa-check-circle"></i> 数据库初始化成功！添加了' + result.backends_added + '个后端。正在跳转...', 'success');
            } else {
              showMessage('<i class="fas fa-times-circle"></i> 初始化失败: ' + (result.error || '未知错误'), 'error');
              btn.disabled = false;
              btn.innerHTML = '<i class="fas fa-play-circle"></i> 重新初始化';
            }
          } catch (error) {
            showMessage('<i class="fas fa-times-circle"></i> 请求失败: ' + error.message, 'error');
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-play-circle"></i> 重新初始化';
          }
        }
        
        async function resetDatabase() {
          if (!confirm('确定要重置数据库吗？这将删除所有统计数据！')) {
            return;
          }
          
          try {
            const response = await fetch('/api/init-db', {
              method: 'POST'
            });
            
            const result = await response.json();
            
            if (result.success) {
              showMessage('<i class="fas fa-check-circle"></i> 数据库重置成功！添加了' + result.backends_added + '个后端。', 'success');
              setTimeout(() => {
                location.reload();
              }, 1500);
            } else {
              showMessage('<i class="fas fa-times-circle"></i> 重置失败: ' + (result.error || '未知错误'), 'error');
            }
          } catch (error) {
            showMessage('<i class="fas fa-times-circle"></i> 请求失败: ' + error.message, 'error');
          }
        }
      </script>
    </body>
    </html>
  `;
  
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8'
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

// API: 获取后端统计
async function handleBackendStats(request, env) {
  logDebug('开始获取后端统计');
  try {
    const result = await env.DB.prepare(`
      SELECT 
        id, url, weight, dynamic_weight,
        total_requests, success_count, fail_count,
        average_response_time, last_response_time,
        last_used, enabled
      FROM backend_servers
      ORDER BY dynamic_weight DESC
    `).all();
    
    logDebug(`获取后端统计成功: 找到${result.results?.length || 0}条记录`);
    logDebug('后端统计详细数据:', result.results);
    
    return new Response(JSON.stringify(result.results || []), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      }
    });
    
  } catch (error) {
    logError('获取后端统计时发生错误', error);
    return new Response(JSON.stringify({
      error: error.message,
      stack: error.stack
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
        backend_url, response_time, status, error_message, request_time
      FROM request_logs
      ORDER BY request_time DESC
      LIMIT 20
    `).all();
    
    logDebug(`获取最近请求成功: 找到${result.results?.length || 0}条记录`);
    
    return new Response(JSON.stringify(result.results || []), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      }
    });
    
  } catch (error) {
    logError('获取最近请求时发生错误', error);
    return new Response(JSON.stringify({
      error: error.message,
      stack: error.stack
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