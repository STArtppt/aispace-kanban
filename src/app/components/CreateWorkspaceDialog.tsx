import { useEffect, useState } from 'react';
import { Check, Copy, Folder, Loader2, Plus } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { writeClipboard } from '@/components/Primitives';
import { ApiError, api, type WorkspaceTemplate } from '@/lib/api';

type Tab = 'create' | 'add';

function DirectoryField({
  value,
  onChange,
  onEnter,
  autoFocus,
  pickerAvailable,
  picking,
  pickerHint,
  onPick,
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  autoFocus?: boolean;
  pickerAvailable: boolean;
  picking: boolean;
  pickerHint: string;
  onPick: () => void;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">路径</span>
      <div className="flex items-center gap-2">
        <Input
          autoFocus={autoFocus}
          className="min-w-0 flex-1"
          value={value}
          placeholder="目录绝对路径"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onEnter()}
        />
        {pickerAvailable ? (
          <TooltipProvider delay={300}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="选择目录"
                    disabled={picking}
                    onClick={onPick}
                    className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                  />
                }
              >
                {picking ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Folder className="size-4" />
                )}
              </TooltipTrigger>
              <TooltipContent>选择目录</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
      {picking ? (
        <span className="text-[11px] text-muted-foreground">
          已打开系统选择框，请在桌面上完成选择
        </span>
      ) : null}
      {pickerHint ? <span className="text-[11px] text-destructive">{pickerHint}</span> : null}
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/**
 * 侧栏「新建」：一个对话框里放「新建工作空间」和「登记已有目录」。
 * 模板列表来自 /api/templates；老服务没有这个接口时选择器和复制按钮都不出现，
 * 行为退回改动前（不选模板直接建）。
 */
export function CreateWorkspaceDialog({ onDone }: { onDone: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('create');
  const [root, setRoot] = useState('');
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState<WorkspaceTemplate[] | null>(null);
  const [createPrompt, setCreatePrompt] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pickerAvailable, setPickerAvailable] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickerHint, setPickerHint] = useState('');

  useEffect(() => {
    if (!open) return;
    setTab('create');
    setRoot('');
    setName('');
    setTemplateId('');
    setTemplates(null);
    setCreatePrompt('');
    setCopied(false);
    setError('');
    setPickerAvailable(false);
    setPicking(false);
    setPickerHint('');
    let alive = true;
    void api
      .templates()
      .then((data) => {
        if (!alive) return;
        const list = Array.isArray(data.templates) ? data.templates : [];
        setTemplates(list);
        setCreatePrompt(typeof data.createPrompt === 'string' ? data.createPrompt : '');
        const preferred = list.find((item) => item.id === 'pm-aispace') ?? list[0];
        if (preferred) setTemplateId(preferred.id);
      })
      .catch(() => {
        if (!alive) return;
        // 404：老服务没有列表接口。当没模板处理，下面创建时不传 template。
        setTemplates([]);
        setCreatePrompt('');
      });
    // 旧服务进程没有这个接口 → 404，不显示文件夹按钮，对话框其余部分与改动前一字不差。
    void api
      .pickDirectoryAvailable()
      .then((data) => {
        if (!alive) return;
        setPickerAvailable(Boolean(data.available));
      })
      .catch(() => {
        if (!alive) return;
        setPickerAvailable(false);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const showTemplatePicker = Boolean(templates && templates.length > 0);

  const submit = async () => {
    if (!root.trim() || (tab === 'create' && !name.trim())) return;
    setBusy(true);
    setError('');
    try {
      const project =
        tab === 'create'
          ? await api.createWorkspace(
              name.trim(),
              root.trim(),
              showTemplatePicker ? templateId : undefined,
            )
          : await api.addProject(root.trim());
      setOpen(false);
      onDone(project.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pickPath = async () => {
    if (picking) return;
    setPicking(true);
    setPickerHint('');
    setError('');
    try {
      const result = await api.pickDirectory();
      if (result.picked && result.path) setRoot(result.path);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setPickerAvailable(false);
        return;
      }
      setPickerHint((err as Error).message);
    } finally {
      setPicking(false);
    }
  };

  return (
    <>
      <Button variant="ghost" size="sm" className="justify-start" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        新建
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPortal>
          <DialogBackdrop />
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>新建</DialogTitle>
              <DialogDescription>
                从模板铺一份工作空间，或把已经存在的目录挂到看板上。
              </DialogDescription>
            </DialogHeader>

            <DialogBody>
              <Tabs
                value={tab}
                onValueChange={(value) => {
                  if (value === 'create' || value === 'add') {
                    setTab(value);
                    setError('');
                  }
                }}
                className="gap-4"
              >
                <TabsList variant="segmented" className="w-full">
                  <TabsTrigger value="create" className="flex-1">
                    新建工作空间
                  </TabsTrigger>
                  <TabsTrigger value="add" className="flex-1">
                    登记已有目录
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="create" className="flex flex-col gap-3">
                  {showTemplatePicker || createPrompt ? (
                    <p className="text-xs text-muted-foreground">
                      没有符合你角色的模板？复制提示词发给
                      AI，它会按你的工作方式建一份空间。建好后把返回的路径填到「登记已有目录」；这份模板下次也会出现在模板类型里。
                    </p>
                  ) : null}

                  {showTemplatePicker ? (
                    <div className="flex items-end gap-2">
                      <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">模板类型</span>
                        <Select
                          value={templateId}
                          onValueChange={(value) => {
                            if (typeof value === 'string' && value) setTemplateId(value);
                          }}
                        >
                          <SelectTrigger aria-label="模板类型">
                            <SelectValue>
                              {(value: string | null) => {
                                const item = value
                                  ? templates?.find((t) => t.id === value)
                                  : undefined;
                                return item?.name ?? null;
                              }}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {templates?.map((item) => (
                              <SelectItem key={item.id} value={item.id}>
                                {item.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </label>
                      {createPrompt ? (
                        <TooltipProvider delay={300}>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  aria-label="创建模板提示词"
                                  onClick={() => {
                                    void writeClipboard(createPrompt).then((ok) => {
                                      if (ok) setCopied(true);
                                    });
                                  }}
                                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                                />
                              }
                            >
                              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                            </TooltipTrigger>
                            <TooltipContent>创建模板提示词</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : null}
                    </div>
                  ) : null}

                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground">名称</span>
                    <Input
                      autoFocus={tab === 'create'}
                      value={name}
                      placeholder="工作空间名称"
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && void submit()}
                    />
                  </label>
                  <DirectoryField
                    value={root}
                    onChange={setRoot}
                    onEnter={() => void submit()}
                    pickerAvailable={pickerAvailable}
                    picking={picking}
                    pickerHint={pickerHint}
                    onPick={() => void pickPath()}
                  />
                </TabsContent>

                <TabsContent value="add" className="flex flex-col gap-3">
                  <DirectoryField
                    autoFocus={tab === 'add'}
                    value={root}
                    onChange={setRoot}
                    onEnter={() => void submit()}
                    pickerAvailable={pickerAvailable}
                    picking={picking}
                    pickerHint={pickerHint}
                    onPick={() => void pickPath()}
                    hint="登记一个已经存在的工作空间，目录里要有 input/ 和 output/。"
                  />
                </TabsContent>
              </Tabs>
              {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
            </DialogBody>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button
                disabled={
                  busy ||
                  !root.trim() ||
                  (tab === 'create' && (!name.trim() || (showTemplatePicker && !templateId)))
                }
                onClick={() => void submit()}
              >
                {tab === 'create' ? '创建' : '登记'}
              </Button>
            </DialogFooter>
          </DialogPopup>
        </DialogPortal>
      </Dialog>
    </>
  );
}
