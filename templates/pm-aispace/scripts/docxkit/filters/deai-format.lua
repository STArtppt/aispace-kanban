--[[
deai-format.lua —— md → docx 之前的格式处理（pandoc 内置 Lua 解释器执行，不需要另装 Lua）。

只动格式节点，不改 Str 的文字。例外只有两处，都计数回报：剥掉标题开头的手写编号、删掉批注块的 [!类型] 标记。

  1. 标题平移：第一个块是 `#`、且全文只有这一个 `#` 时，把它取作文档标题（front-matter 没写 title 时补进 meta），
     其余标题整体上移一级（`##` → 一级标题）。多个 `#` 不平移，回报数量由调用方给 warning。
  2. 手写编号剥离（-M strip-heading-numbers=true，即模板的标题样式自带编号时）：
     平移后 1–3 级标题开头的 `1.`、`2.1`、`一、`、`（一）`、`第三章` 等连同其后空白去掉；4 级是无编号小标题，不动。
  3. 批注块：`> [!note]` 这类引用块转成 custom-style="提示框" 的 Div；标记后的自定义标题作为首行加粗保留。
  4. 加粗（-M keep-bold=true 时跳过）：正文段落与列表项里只保留段首标签式加粗（首个元素是加粗，
     且以「：」「:」结尾或紧跟「：」「:」），其余解除；表格与标题不处理。
  5. 东亚换行：读入时不开 east_asian_line_breaks（它会在过滤器之前吞掉批注块标题后的换行），
     这里按同一规则补做：换行两侧都是东亚宽字符时删掉，免得中文里多出空格。
  6. -M aispace-front=true（模板有前置区）：去掉 meta 的 title / subtitle / author / date，
     不让 pandoc 生成 Title 段 —— 封面由前置区给出。

处理计数写到 stderr 的 `[aispace-deai] 键=值` 行，由 docxkit/pandoc.py 读回（不写进成品的元数据，免得漏给收件人）。
]]

local counts = { shifted = 0, h1 = 0, numbers = 0, callouts = 0, bold = 0, softbreaks = 0 }
local unknown_callouts = {}
local doc_title = nil

local KNOWN = { note = true, tip = true, important = true, warning = true, caution = true }

local function flag(meta, key)
  local v = meta[key]
  if v == nil then return false end
  if type(v) == "boolean" then return v end
  local s = pandoc.utils.stringify(v)
  return s == "true" or s == "1" or s == "yes"
end

-- ---------- 东亚宽字符 ----------
local function wide(cp)
  return cp and ((cp >= 0x1100 and cp <= 0x115F) or (cp >= 0x2E80 and cp <= 0xA4CF)
    or (cp >= 0xAC00 and cp <= 0xD7A3) or (cp >= 0xF900 and cp <= 0xFAFF)
    or (cp >= 0xFE30 and cp <= 0xFE4F) or (cp >= 0xFF00 and cp <= 0xFF60)
    or (cp >= 0xFFE0 and cp <= 0xFFE6) or (cp >= 0x20000 and cp <= 0x3FFFD))
end

local function first_cp(s)
  if not s or s == "" then return nil end
  local ok, cp = pcall(utf8.codepoint, s, 1)
  return ok and cp or nil
end

local function last_cp(s)
  if not s or s == "" then return nil end
  local ok, off = pcall(utf8.offset, s, -1)
  if not ok or not off then return nil end
  local ok2, cp = pcall(utf8.codepoint, s, off)
  return ok2 and cp or nil
end

local function edge_text(el, last)
  if el == nil then return nil end
  if el.t == "Str" then return el.text end
  if el.content and type(el.content) == "table" and #el.content > 0 and el.t ~= "Note" then
    return edge_text(el.content[last and #el.content or 1], last)
  end
  return nil
end

local function join_east_asian(inlines)
  local out = pandoc.List()
  for i, el in ipairs(inlines) do
    if el.t == "SoftBreak" and wide(last_cp(edge_text(inlines[i - 1], true)))
        and wide(first_cp(edge_text(inlines[i + 1], false))) then
      counts.softbreaks = counts.softbreaks + 1
    else
      out:insert(el)
    end
  end
  return out
end

-- ---------- 手写编号 ----------
local CN = {}
for _, ch in ipairs({ "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "百", "零", "〇", "两" }) do
  CN[ch] = true
end

-- 从第 i 个字节起吃掉连续的中文数字，返回停下的位置
local function eat_cn(s, i)
  local j = i
  while j <= #s do
    local ch = s:match("^[\xC0-\xF7][\x80-\xBF]*", j)
    if not ch or not CN[ch] then break end
    j = j + #ch
  end
  return j
end

-- 返回剥掉编号后的剩余文字；认不出编号返回 nil。whole = 这个 Str 后面紧跟空格（编号独占一个 Str）
local function strip_number(s, whole)
  -- 1.  2.1  2.1.3  1.1.
  local num, dot = s:match("^(%d+[%.%d]*%d*)(%.?)")
  if num then
    num = num:gsub("%.$", function() dot = "."; return "" end)
    local rest = s:sub(#num + #dot + 1)
    if rest == "" and whole then return "" end
    if rest:sub(1, 3) == "、" then return rest:sub(4) end
    if dot == "." and rest ~= "" and not rest:match("^%d") then return rest end
    return nil
  end
  -- 第三章 / 第3节 / 第一部分
  if s:sub(1, 3) == "第" then
    local j = 4
    local d = s:match("^%d+", j)
    if d then j = j + #d else j = eat_cn(s, j) end
    if j > 4 then
      for _, unit in ipairs({ "章", "节", "部分", "篇" }) do
        if s:sub(j, j + #unit - 1) == unit then
          local rest = s:sub(j + #unit)
          if rest:sub(1, 3) == "、" or rest:sub(1, 3) == "　" then rest = rest:sub(4) end
          return rest
        end
      end
    end
    return nil
  end
  -- 一、
  local j = eat_cn(s, 1)
  if j > 1 and s:sub(j, j + 2) == "、" then return s:sub(j + 3) end
  -- （一） (一)
  local open = (s:sub(1, 3) == "（" and 3) or (s:sub(1, 1) == "(" and 1) or nil
  if open then
    local k = eat_cn(s, open + 1)
    if k > open + 1 then
      if s:sub(k, k + 2) == "）" then return s:sub(k + 3) end
      if s:sub(k, k) == ")" then return s:sub(k + 1) end
    end
  end
  return nil
end

local function strip_heading(h)
  local c = h.content
  if #c == 0 or c[1].t ~= "Str" then return h end
  local rest = strip_number(c[1].text, #c == 1 or (c[2] and c[2].t == "Space"))
  if rest == nil then return h end
  rest = rest:gsub("^　+", "")
  local out = pandoc.List()
  local skip_space = rest == ""
  if rest ~= "" then out:insert(pandoc.Str(rest)) end
  for i = 2, #c do
    if skip_space and c[i].t == "Space" then
      skip_space = false
    else
      skip_space = false
      out:insert(c[i])
    end
  end
  if #out == 0 then return h end -- 标题只有编号：保持原样，免得出空标题
  counts.numbers = counts.numbers + 1
  h.content = out
  return h
end

-- ---------- 加粗 ----------
local function ends_with_colon(s)
  return s and (s:sub(-3) == "：" or s:sub(-1) == ":")
end

local function starts_with_colon(s)
  return s and (s:sub(1, 3) == "：" or s:sub(1, 1) == ":")
end

local function is_label(inlines)
  local first = inlines[1]
  if not first or first.t ~= "Strong" then return false end
  local text = pandoc.utils.stringify(first)
  if ends_with_colon(text) then return true end
  local nxt = inlines[2]
  return nxt ~= nil and nxt.t == "Str" and starts_with_colon(nxt.text)
end

local bold_pass -- 下面定义；脚注里的段落要递归回来

-- 嵌在强调、链接里的加粗同样解除（它们不可能是段首标签）
local UNBOLD = {
  Strong = function(s)
    counts.bold = counts.bold + 1
    return s.content
  end,
}

local function unbold(inlines)
  local keep = is_label(inlines)
  local out = pandoc.List()
  for i, el in ipairs(inlines) do
    if keep and i == 1 then
      out:insert(el)
    elseif el.t == "Strong" then
      counts.bold = counts.bold + 1
      out:extend(pandoc.Inlines(el.content):walk(UNBOLD))
    elseif el.t == "Note" then
      el.content = bold_pass(pandoc.Blocks(el.content)) -- 脚注里是独立的段落，各按段首规则处理
      out:insert(el)
    else
      out:insert(pandoc.walk_inline(el, UNBOLD))
    end
  end
  return out
end

-- 只处理正文段落与列表项；表格、标题、代码不进
bold_pass = function(blocks)
  return blocks:walk({
    traverse = "topdown",
    Table = function(t) return t, false end,
    Header = function(h) return h, false end,
    Para = function(p) p.content = unbold(p.content); return p, false end,
    Plain = function(p) p.content = unbold(p.content); return p, false end,
  })
end

-- ---------- 批注块 ----------
local function callout(bq)
  local first = bq.content[1]
  if not first or (first.t ~= "Para" and first.t ~= "Plain") then return nil end
  local c = first.content
  if #c == 0 or c[1].t ~= "Str" then return nil end
  local kind, tail = c[1].text:match("^%[!(%a+)%][%+%-]?(.*)$")
  if not kind then return nil end
  kind = kind:lower()
  if not KNOWN[kind] then unknown_callouts[#unknown_callouts + 1] = kind end
  -- 标记之后、第一个换行之前是自定义标题；之后是正文
  local title, body = pandoc.List(), pandoc.List()
  if tail ~= "" then title:insert(pandoc.Str(tail)) end
  local in_title = true
  for i = 2, #c do
    local el = c[i]
    if in_title and (el.t == "SoftBreak" or el.t == "LineBreak") then
      in_title = false
    elseif in_title then
      title:insert(el)
    else
      body:insert(el)
    end
  end
  while #title > 0 and title[1].t == "Space" do title:remove(1) end
  while #title > 0 and title[#title].t == "Space" do title:remove(#title) end
  local blocks = pandoc.List()
  if #title > 0 then blocks:insert(pandoc.Para({ pandoc.Strong(title) })) end
  if #body > 0 then blocks:insert(pandoc.Para(body)) end
  for i = 2, #bq.content do blocks:insert(bq.content[i]) end
  if #blocks == 0 then return nil end
  counts.callouts = counts.callouts + 1
  return pandoc.Div(blocks, pandoc.Attr("", {}, { { "custom-style", "提示框" } }))
end

-- ---------- 主流程 ----------
function Pandoc(doc)
  local meta = doc.meta
  local strip = flag(meta, "strip-heading-numbers")
  local keep_bold = flag(meta, "keep-bold")
  local front = flag(meta, "aispace-front")
  local blocks = doc.blocks

  for _, b in ipairs(blocks) do
    if b.t == "Header" and b.level == 1 then counts.h1 = counts.h1 + 1 end
  end
  -- 1. 标题平移
  if counts.h1 == 1 and blocks[1] and blocks[1].t == "Header" and blocks[1].level == 1 then
    local h = blocks:remove(1)
    doc_title = pandoc.utils.stringify(h.content)
    if meta.title == nil then meta.title = pandoc.MetaInlines(h.content) end
    blocks = blocks:walk({
      Header = function(x)
        x.level = math.max(1, x.level - 1)
        return x
      end,
    })
    counts.shifted = 1
  end
  if meta.title ~= nil then
    doc_title = pandoc.utils.stringify(meta.title)
  end
  -- 2. 手写编号
  if strip then
    blocks = blocks:walk({
      Header = function(x)
        if x.level <= 3 then return strip_heading(x) end
        return x
      end,
    })
  end
  -- 4. 加粗（先于批注块：提示框标题是这里之后才加的加粗）
  if not keep_bold then blocks = bold_pass(blocks) end
  -- 3. 批注块（要用到换行，所以排在东亚换行之前）
  blocks = blocks:walk({ BlockQuote = function(bq) return callout(bq) end })
  -- 5. 东亚换行
  blocks = blocks:walk({ Inlines = join_east_asian })
  meta.title = meta.title and pandoc.MetaInlines(join_east_asian(pandoc.Inlines(meta.title))) or nil

  -- 6. 前置区：不让 pandoc 生成 Title / Author / Date 段
  if front then
    meta.title, meta.subtitle, meta.author, meta.date = nil, nil, nil, nil
  end

  local function emit(k, v) io.stderr:write("[aispace-deai] " .. k .. "=" .. tostring(v) .. "\n") end
  emit("h1", counts.h1)
  emit("shifted", counts.shifted)
  emit("numbers", counts.numbers)
  emit("callouts", counts.callouts)
  emit("bold", keep_bold and -1 or counts.bold)
  emit("unknownCallouts", table.concat(unknown_callouts, ","))
  if doc_title then emit("title", (doc_title:gsub("[\r\n]+", " "))) end
  return pandoc.Pandoc(blocks, meta)
end
