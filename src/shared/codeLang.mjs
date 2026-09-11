/**
 * 代码文件扩展名 → Shiki 语言 id —— **前端与服务端共用的唯一一份**。
 *
 * 服务端用它把这些文件标成 `reader: 'text'`（预览窗才能打开，而不是「网页里不渲染」）；
 * 前端用它选高亮语言。两边必须同源：漏一边就会「列表里能点、预览却是原始格式」。
 *
 * `.txt` / `.md` / `.csv` 不在这张表里：它们各有自己的 reader。
 * 对不上语言或高亮抛错时前端退回纯文本，不把文件改标成 external。
 *
 * **这个目录的边界:只放两侧共用的纯函数。** 不碰 DOM、不碰 Node API、零依赖。
 */

/**
 * @type {Readonly<Record<string, string>>}
 */
export const CODE_LANG_BY_EXT = Object.freeze({
  // 配置 / 数据（第一批代码预览就认这四种）
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.json5': 'jsonc',
  '.xml': 'xml',
  '.toml': 'toml',
  '.ini': 'ini',

  // 查询 / 脚本
  '.sql': 'sql',
  '.py': 'python',
  '.pyi': 'python',
  '.pyw': 'python',
  '.r': 'r',
  '.lua': 'lua',
  '.pl': 'perl',
  '.pm': 'perl',

  // JS / TS
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.mdx': 'mdx',

  // 样式（.html 走 iframe 预览，不进这张表）
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',

  // 系统语言
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.rb': 'ruby',
  '.php': 'php',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.scala': 'scala',
  '.sc': 'scala',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hrl': 'erlang',
  '.hs': 'haskell',
  '.clj': 'clojure',
  '.cljs': 'clojure',
  '.cljc': 'clojure',
  '.zig': 'zig',
  '.sol': 'solidity',

  // Shell
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.bat': 'bat',
  '.cmd': 'bat',

  // 接口 / 基础设施
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.proto': 'proto',
  '.tf': 'terraform',
  '.tfvars': 'terraform',
  '.hcl': 'hcl',
  '.cmake': 'cmake',
  '.groovy': 'groovy',
  '.diff': 'diff',
  '.patch': 'diff',
});
