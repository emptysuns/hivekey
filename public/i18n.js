/* hivekey — ultra-light i18n. Gettext style: the English string is the key,
 * missing keys fall back to the key itself. `t('{n} rows', {n: 5})` fills
 * `{placeholders}` after lookup. */
'use strict';

const I18N_DICT = {
  'zh-CN': {
    // shell / nav
    'Dashboard': '仪表盘',
    'Channels': '渠道',
    'Tokens': '令牌',
    'Logs': '日志',
    'Settings': '设置',
    'Logout': '退出登录',
    'Live': '已连接',
    'Disconnected': '未连接',

    // login
    'Sign in to the admin console': '登录管理控制台',
    'Username': '用户名',
    'Password': '密码',
    'Sign in': '登录',
    'invalid username or password': '用户名或密码错误',
    'too many login attempts, try again later': '登录尝试过多，请稍后再试',
    'Session expired. Please sign in again.': '会话已过期,请重新登录。',

    // common
    'Loading…': '加载中…',
    'never': '从未',
    'just now': '刚刚',
    '{n}s ago': '{n} 秒前',
    '{n}m ago': '{n} 分钟前',
    '{n}h ago': '{n} 小时前',
    'Network error. Is the server running?': '网络错误,服务是否在运行?',
    'Cancel': '取消',
    'Edit': '编辑',
    'Delete': '删除',
    'Actions': '操作',
    'Enabled': '已启用',
    'Name': '名称',
    'Status': '状态',
    'Model': '模型',
    'Channel': '渠道',
    'Key': '密钥',
    'Keys': '密钥',
    'Time': '时间',
    'Attempts': '尝试',
    'Latency': '延迟',
    'Refresh': '刷新',
    'Copy': '复制',
    'ok': '成功',
    'error': '错误',
    'channel not found': '渠道不存在',
    'key not found': '密钥不存在',
    'token not found': '令牌不存在',

    // dashboard
    'Uptime {t}': '运行时长 {t}',
    '{n} channels': '{n} 个渠道',
    'Total requests': '总请求数',
    'Success rate': '成功率',
    '{ok} ok / {failed} failed': '成功 {ok} / 失败 {failed}',
    'Requests / min': '每分钟请求',
    'Avg latency': '平均延迟',
    'In flight': '进行中',
    '{n} retries total': '累计重试 {n} 次',
    'Tokens used': 'Token 用量',
    '{p} prompt / {c} completion': '输入 {p} / 输出 {c}',
    'active': '可用',
    'cooldown': '冷却',
    'disabled': '停用',
    'Requests per minute': '每分钟请求数',
    'Success': '成功',
    'Failed': '失败',
    'Live requests': '进行中的请求',
    'Recent requests': '最近请求',
    'Started': '开始时间',
    'Elapsed': '已耗时',
    'No traffic yet': '暂无流量',
    'No requests in flight.': '当前没有进行中的请求。',
    'No finished requests yet.': '还没有完成的请求。',
    '{n} requests': '{n} 个请求',
    '{n} success': '成功 {n}',
    '{n} failed': '失败 {n}',

    // channels
    '+ Add channel': '+ 添加渠道',
    'Base URL': '接口地址',
    'Priority': '优先级',
    'Weight': '权重',
    'Requests': '请求',
    'Failed to load channels.': '渠道加载失败。',
    'No channels yet. Add one to start routing requests.': '还没有渠道,添加一个开始转发请求。',
    'Keys · {name}': '密钥 · {name}',
    'Reveal keys': '显示完整密钥',
    'Delete selected': '删除选中',
    'Delete selected ({n})': '删除选中（{n}）',
    'Loading keys…': '密钥加载中…',
    'No keys in this channel. Import some below.': '该渠道还没有密钥,在下方导入。',
    'Req': '请求',
    'OK': '成功',
    'Fail': '失败',
    'Last error': '最近错误',
    'Enable': '启用',
    'Disable': '停用',
    'Reset': '重置',
    'Test': '测试',
    'Testing…': '测试中…',
    'Test failed · {err}': '测试失败 · {err}',
    'Import keys': '导入密钥',
    '(one key per line)': '（每行一个密钥）',
    'cooldown · {n}s': '冷却 · {n} 秒',
    'Channel enabled': '渠道已启用',
    'Channel disabled': '渠道已停用',
    'Channel updated': '渠道已更新',
    'Channel created': '渠道已创建',
    'Channel deleted': '渠道已删除',
    'Delete channel "{name}" and all of its keys?': '删除渠道「{name}」及其全部密钥？',
    'Key enabled': '密钥已启用',
    'Key disabled': '密钥已停用',
    'Key reset': '密钥已重置',
    'Key deleted': '密钥已删除',
    'Delete this key?': '删除这个密钥？',
    'Delete {n} selected keys?': '删除选中的 {n} 个密钥？',
    'Deleted {n} keys': '已删除 {n} 个密钥',
    'Paste at least one key first': '请先粘贴至少一个密钥',
    'Imported: {added} added, {skipped} skipped': '导入完成：新增 {added}，跳过 {skipped}',
    '{added} added, {skipped} skipped': '新增 {added}，跳过 {skipped}',

    // channel modal
    'Edit channel': '编辑渠道',
    'Add channel': '添加渠道',
    'Proxy': '代理',
    '(optional, e.g. http://127.0.0.1:7890)': '（可选，如 http://127.0.0.1:7890）',
    '(higher = preferred)': '（越大越优先）',
    'Models': '模型列表',
    '(comma-separated; empty = all)': '（逗号分隔；留空表示全部）',
    'Model mapping': '模型映射',
    '(JSON, requested → upstream)': '（JSON，请求模型 → 上游模型）',
    'Key header': '密钥请求头',
    'Key prefix': '密钥前缀',
    'Fetch models': '获取模型列表',
    'Pulls /v1/models from the Base URL above.': '从上方接口地址拉取 /v1/models。',
    'Enter a Base URL first': '请先填写接口地址',
    'Fetching…': '获取中…',
    'Fetch failed': '获取失败',
    '{n} models · {ms}': '{n} 个模型 · {ms}',
    'The endpoint returned no models.': '该接口没有返回任何模型。',
    'Select all': '全选',
    'Filter…': '筛选…',
    '{sel} / {total} selected': '已选 {sel} / {total}',
    'Ticked models fill the field above.': '勾选的模型会填入上方模型列表。',
    'Apply selection': '应用所选',
    'API keys': 'API 密钥',
    '(one per line, optional)': '（每行一个，可选）',
    'Save changes': '保存修改',
    'Create channel': '创建渠道',
    'Model mapping must be a valid JSON object': '模型映射必须是合法的 JSON 对象',

    // tokens
    'Access tokens': '访问令牌',
    'Token name (e.g. my-app)': '令牌名称（如 my-app）',
    'Create token': '创建令牌',
    'Use this as the Bearer token when calling the pool’s /v1 endpoint.': '调用本服务 /v1 接口时，将其用作 Bearer 令牌。',
    'Token': '令牌',
    'Created': '创建时间',
    'Last used': '最近使用',
    'Failed to load tokens.': '令牌加载失败。',
    'No access tokens yet. Create one so clients can call /v1.': '还没有访问令牌,创建一个以便客户端调用 /v1。',
    'Copied to clipboard': '已复制到剪贴板',
    'Copy failed. Select the token manually.': '复制失败,请手动选择令牌。',
    'Token created': '令牌已创建',
    'Token deleted': '令牌已删除',
    'Token enabled': '令牌已启用',
    'Token disabled': '令牌已停用',
    'Delete this access token? Clients using it will stop working.': '删除这个访问令牌？正在使用它的客户端将无法访问。',

    // logs
    'Request logs': '请求日志',
    'Search model, path, key, error…': '搜索模型、路径、密钥、错误…',
    'All channels': '全部渠道',
    'All statuses': '全部状态',
    'Error': '错误',
    '{n} rows': '{n} 行',
    'Path': '路径',
    'Failed to load logs.': '日志加载失败。',
    'No log entries match.': '没有匹配的日志。',
    'Request:': '请求：',
    'stream': '流式',
    'Tokens:': 'Token：',
    'Error:': '错误：',
    'Retries ({n}):': '重试（{n}）：',
    'No retries. The first attempt succeeded.': '无重试,首次尝试即成功。',
    'No retries. The first attempt failed.': '无重试,首次尝试失败。',

    // settings
    'Key selection strategy': '密钥调度策略',
    'Smart (adaptive)': '智能（自适应）',
    'Scores keys by latency, errors and load, picks the best (recommended).': '根据延迟、错误率和负载给密钥打分并择优（推荐，默认）。',
    'Round robin': '轮询',
    'Cycles through active keys in fixed order.': '按固定顺序轮流使用可用密钥。',
    'Random': '随机',
    'Picks a uniformly random active key.': '完全随机选择一个可用密钥。',
    'Weighted': '加权随机',
    'Random pick biased by channel weight.': '按渠道权重加权的随机选择。',
    'Least in-flight': '最少并发',
    'Prefers the key with the fewest requests in flight.': '优先选择进行中请求最少的密钥。',
    'Lowest latency': '最低延迟',
    'Prefers the key with the lowest recent average latency.': '优先选择近期平均延迟最低的密钥。',
    'Max attempts': '最大尝试次数',
    'Total tries per request (first attempt + retries).': '每个请求的总尝试次数（首次 + 重试）。',
    'Request timeout (ms)': '请求超时（毫秒）',
    'Overall upstream request timeout.': '上游请求的总超时时间。',
    'Connect timeout (ms)': '连接超时（毫秒）',
    'Upstream connection timeout.': '上游连接超时时间。',
    'Cooldown after 429 (ms)': '429 后冷却（毫秒）',
    'Base cooldown when a key gets rate-limited.': '密钥被限流后的基础冷却时间。',
    'Cooldown after error (ms)': '错误后冷却（毫秒）',
    'Base cooldown after other upstream errors.': '其他上游错误后的基础冷却时间。',
    'Max cooldown (ms)': '最大冷却（毫秒）',
    'Upper bound for exponential cooldown.': '指数冷却的上限。',
    'Disable after failures': '连续失败后停用',
    'Auto-disable a key after this many consecutive failures.': '连续失败达到该次数后自动停用密钥。',
    'Log limit': '日志上限',
    'Number of request logs kept in memory.': '内存中保留的请求日志条数。',
    'Retry on status codes': '重试状态码',
    '(comma-separated)': '（逗号分隔）',
    'A response with one of these codes triggers a retry on another key.': '返回这些状态码时会换一个密钥重试。',
    'Allow anonymous access to /v1 (no access token required)': '允许匿名访问 /v1（无需访问令牌）',
    'Save settings': '保存设置',
    'Saved ✓': '已保存 ✓',
    'Settings saved': '设置已保存',
    'Failed to load settings.': '设置加载失败。',
    'Retry codes must be HTTP status codes (100–599)': '重试码必须是 HTTP 状态码（100–599）',
  },
};

let I18N_LANG = (() => {
  try {
    const saved = localStorage.getItem('hivekey-lang');
    if (saved && (saved === 'en' || I18N_DICT[saved])) return saved;
  } catch (e) { /* storage unavailable */ }
  return (navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh-CN' : 'en';
})();

function t(str, params) {
  const dict = I18N_DICT[I18N_LANG];
  let out = (dict && dict[str]) || str;
  if (params) {
    out = out.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? params[k] : m));
  }
  return out;
}

function setLang(lang) {
  I18N_LANG = (lang === 'en' || I18N_DICT[lang]) ? lang : 'en';
  try { localStorage.setItem('hivekey-lang', I18N_LANG); } catch (e) { /* ignore */ }
  applyStaticI18n();
}

/* Translate static markup: data-i18n (textContent), data-i18n-title,
 * data-i18n-placeholder. Also syncs <html lang> and the language pickers. */
function applyStaticI18n() {
  document.documentElement.lang = I18N_LANG === 'zh-CN' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
  document.querySelectorAll('[data-lang-sel]').forEach((sel) => {
    sel.value = I18N_LANG;
  });
}

applyStaticI18n();
