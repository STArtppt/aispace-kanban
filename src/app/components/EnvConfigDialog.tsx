import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogPortal,
  DialogBackdrop,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { writeClipboard } from '@/components/Primitives';

export type EnvConfigKind = 'api_key' | 'database';

/** 与 templates/pm-aispace/.claude/skills/pm-env-config/references/kanban-prompt.md 同一份固定头 / 输出要求。 */
const PROMPT_HEAD =
  '请按 pm-env-config 技能配置下面的环境参数。凭据只写入 .env，不要写进 yaml 或任何会入库的文件。';

const PROMPT_TAIL =
  '输出要求：配完后用几句简单易懂的话说明结果——配了哪个源或哪个变量、文件落在哪、数据库连上了没有、还缺什么。不要贴配置原文，不要回显口令或 token。';

const COPY_COOLDOWN_MS = 1500;

const DB_CONNECTION_EXAMPLE = [
  'jdbc:mysql://127.0.0.1:3306/example_db',
  'username: readonly',
  'password: ********',
].join('\n');

type ApiKeyFields = {
  key: string;
  value: string;
};

const EMPTY_API_KEY: ApiKeyFields = {
  key: 'MINERU_API_KEY',
  value: '',
};

function withPromptTail(body: string): string {
  return `${body.trimEnd()}\n\n${PROMPT_TAIL}\n`;
}

function buildApiKeyPrompt(fields: ApiKeyFields): string {
  const lines = ['kind: api_key'];
  if (fields.key.trim()) lines.push(`key: ${fields.key.trim()}`);
  if (fields.value) lines.push(`value: ${fields.value}`);
  return withPromptTail(`${PROMPT_HEAD}\n\n${lines.join('\n')}`);
}

function buildDatabasePrompt(name: string, raw: string): string {
  const lines = ['kind: database'];
  if (name.trim()) lines.push(`name: ${name.trim()}`);
  const body = raw.trim();
  return withPromptTail(`${PROMPT_HEAD}\n\n${lines.join('\n')}${body ? `\n\n${body}` : ''}`);
}

/**
 * 两个「添加」弹窗共用的壳：复制 prompt、失败时把原文摊开。
 * 字段不进任何接口。关闭后由调用方卸掉 open，值在各自弹窗里清掉。
 */
function PromptDialog({
  open,
  title,
  missing,
  prompt,
  onOpenChange,
  children,
}: {
  open: boolean;
  title: string;
  missing: string;
  prompt: string;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [promptFallback, setPromptFallback] = useState('');

  useEffect(() => {
    if (!open) {
      setCopying(false);
      setCopied(false);
      setPromptFallback('');
      return;
    }
    setCopying(false);
    setCopied(false);
    setPromptFallback('');
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPY_COOLDOWN_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    if (missing || copying || copied) return;
    setPromptFallback('');
    setCopying(true);
    const ok = await writeClipboard(prompt);
    setCopying(false);
    if (ok) {
      toast.success('已复制，粘给当前 Agent');
      setCopied(true);
      return;
    }
    toast.error('复制失败。这段看板跑在 http 下时浏览器常常不给剪贴板，请从下面的框里手工选中复制。');
    setPromptFallback(prompt);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="max-h-[90vh] overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              只进剪贴板，粘给 AI 后建议清空。看板不存口令，刷新页面即丢。
            </DialogDescription>
          </DialogHeader>

          {/*
            Popup 只有 max-h 没有明确 height 时，子项默认 min-height:auto 会把表单撑出视口再被裁掉。
            overflow-hidden + body min-h-0 overflow-y-auto 让长内容在弹窗里滚；
            p-1 给 Input 的 focus ring（ring-2 + ring-offset-2）留空，避免贴边被切。
          */}
          <DialogBody className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-1">
            {children}
            {missing ? <p className="text-xs text-muted-foreground">{missing}</p> : null}
            {promptFallback ? (
              <Textarea
                readOnly
                value={promptFallback}
                className="min-h-32 font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
            ) : null}
          </DialogBody>

          <DialogFooter className="shrink-0">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
            <Button
              disabled={Boolean(missing) || copying || copied}
              onClick={() => void copy()}
            >
              复制 prompt 给 AI
            </Button>
          </DialogFooter>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/** 「原始资料」标题栏的 key 按钮打开。变量名预填 MinerU，可改。 */
export function ApiKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [fields, setFields] = useState<ApiKeyFields>(EMPTY_API_KEY);

  useEffect(() => {
    if (!open) setFields(EMPTY_API_KEY);
  }, [open]);

  const miss: string[] = [];
  if (!fields.key.trim()) miss.push('变量名');
  if (!fields.value) miss.push('值');
  const missing = miss.length ? `还缺${miss.join('、')}` : '';

  return (
    <PromptDialog
      open={open}
      title="添加 API Key"
      missing={missing}
      prompt={buildApiKeyPrompt(fields)}
      onOpenChange={onOpenChange}
    >
      <div className="flex min-w-0 flex-col gap-3">
        <Field label="变量名">
          <Input
            value={fields.key}
            placeholder="MINERU_API_KEY"
            onChange={(e) => setFields((prev) => ({ ...prev, key: e.target.value }))}
          />
        </Field>
        <Field label="值">
          <Input
            type="password"
            value={fields.value}
            placeholder="sk-......"
            autoComplete="off"
            onChange={(e) => setFields((prev) => ({ ...prev, value: e.target.value }))}
          />
        </Field>
      </div>
    </PromptDialog>
  );
}

/**
 * 「数据库源」标题栏的数据库按钮打开。
 * 只收显示名 + 一段连接信息原文：拆引擎/主机/口令是 Agent 按 pm-env-config 做的事。
 */
export function DatabaseSourceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [raw, setRaw] = useState('');

  useEffect(() => {
    if (!open) {
      setName('');
      setRaw('');
    }
  }, [open]);

  const missing = raw.trim() ? '' : '还缺连接信息';

  return (
    <PromptDialog
      open={open}
      title="添加数据库源"
      missing={missing}
      prompt={buildDatabasePrompt(name, raw)}
      onOpenChange={onOpenChange}
    >
      <div className="flex min-w-0 flex-col gap-3">
        <Field label="显示名（不填则用库名）">
          <Input
            value={name}
            placeholder="本系统测试库"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="连接信息">
          <Textarea
            value={raw}
            placeholder={DB_CONNECTION_EXAMPLE}
            className="min-h-32 resize-y font-mono text-xs"
            onChange={(e) => setRaw(e.target.value)}
          />
        </Field>
      </div>
    </PromptDialog>
  );
}
