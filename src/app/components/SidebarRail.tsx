import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CircleHelp,
  Moon,
  PanelLeftDashed,
  PanelLeftOpen,
  RefreshCw,
  Repeat,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import { HeaderIconButton } from '@/components/Primitives';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { View } from '@/hooks/useBoardSession';
import type { Project } from '@/lib/api';
import { cn } from '@/lib/utils';

/** 与侧栏进出场时长一致，收起/展开才是同一条动画曲线 */
const RAIL_MOTION = 'transition-transform duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)]';
/**
 * 工具条总宽（border-box），单位 px —— 与下面的 `w-[41px]` 是同一个数，改一处要同步改另一处。
 * 取 41 而不是 40：右边框吃掉 1px 后内容区正好 40，32px 的按钮居中落在整数像素上；
 * 内容区若是奇数（40-1=39），按钮会停在 x=3.5，图标被亚像素抗锯齿糊掉。
 */
const RAIL_W_PX = 41;
/** 鼠标热区在工具条四周外扩这么多：不用贴到屏幕边也能唤出 */
const HOVER_PAD_PX = 20;
/** 触屏唤出手势：起手点必须落在左边缘这条带里 */
const EDGE_ZONE_PX = 24;
/** 触屏唤出手势：横向要划够这么远才算数，且横向位移得大于纵向（否则那是在滚页面） */
const SWIPE_MIN_PX = 40;

export interface SidebarRailProps {
  /** 视图清单由 App 传进来，和完整侧栏共用同一份，避免两处漂移 */
  nav: { key: View; label: string; icon: LucideIcon }[];
  view: View;
  setView: (v: View) => void;
  /** 工作空间清单：切换是低频操作，收进设置面板的二级列表，不占工具条的格子 */
  projects: Project[];
  activeId: string;
  onSelectProject: (id: string) => void;
  /** 宽屏是复位完整侧栏，窄屏是拉开抽屉 —— 由 App 决定 */
  onExpand: () => void;
  loading: boolean;
  reload: () => void | Promise<void>;
  openHelp: () => void;
  dark: boolean;
  toggleTheme: () => void;
  autoHide: boolean;
  setAutoHide: (v: boolean) => void;
  version: string;
}

function RailDivider() {
  return <span aria-hidden className="my-0.5 h-px w-4 shrink-0 bg-border" />;
}

function SettingRow({
  icon: Icon,
  label,
  spinning,
  children,
}: {
  icon: LucideIcon;
  label: string;
  spinning?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <Icon className={cn('size-4 shrink-0 text-muted-foreground', spinning && 'animate-spin')} />
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      {children}
    </div>
  );
}

/**
 * 侧栏收起后贴在左边的悬浮工具条。
 *
 * 三组按钮:切换工作空间 / 四个视图 / 展开侧栏 + 设置,组间用短横线分割。
 * 高度由图标撑起、垂直居中、右侧两角圆角,**始终悬浮**不占布局宽度 ——
 * 所以半透明(85%)+ 背景模糊,压住的正文还能透出来一点,不至于像块实心挡板。
 *
 * 自动隐藏开启时向左收起、露出 8px:桌面靠一块「工具条外扩 20px」的热区接住鼠标(见下面的 mousemove),
 * 触屏没有 hover,所以另给一个「从左边缘向右划」的手势。唤出后点/触工具条以外的地方就收回去。
 */
export function SidebarRail({
  nav,
  view,
  setView,
  projects,
  activeId,
  onSelectProject,
  onExpand,
  loading,
  reload,
  openHelp,
  dark,
  toggleTheme,
  autoHide,
  setAutoHide,
  version,
}: SidebarRailProps) {
  const [hovered, setHovered] = useState(false);
  const [touchRevealed, setTouchRevealed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const settingsBoxRef = useRef<HTMLDivElement>(null);
  const hoveredRef = useRef(false);
  const revealed = !autoHide || hovered || touchRevealed || settingsOpen;

  /*
    垂直居中自己算一个整数 top。用 CSS 的 top-1/2 + -translate-y-1/2 时，
    只要工具条高度和窗口高度奇偶不同就会落在半像素（实测 top=338.5），
    元素整体被亚像素渲染，图标线条跟着发虚。transform 于是只剩 X 方向做进出场。
  */
  useLayoutEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const place = () => {
      const box = el.parentElement?.clientHeight ?? window.innerHeight;
      el.style.top = `${Math.max(0, Math.round((box - el.offsetHeight) / 2))}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [nav.length]);

  // 关掉自动隐藏时工具条常驻，之前的悬停/手势态留着会让下次开启后一直不收
  useEffect(() => {
    if (!autoHide) {
      hoveredRef.current = false;
      setHovered(false);
      setTouchRevealed(false);
    }
  }, [autoHide]);

  /*
    鼠标唤出走一个「工具条四周外扩 20px」的热区，而不是元素自己的 mouseenter/mouseleave。
    因为热区比工具条宽：鼠标停在两者之间时，元素级的 mouseleave 会立刻把它收回去，
    收回后又落进热区 → 再弹出，来回抖动。进出用同一个判据才不会打架。
    热区不是真实 DOM 元素，所以正文左侧该点的地方照样点得到。
  */
  useEffect(() => {
    if (!autoHide) return;
    const onMove = (e: MouseEvent) => {
      const el = railRef.current;
      if (!el) return;
      // 横向绝大多数移动都在这里就返回了，不必每帧量一次 rect
      if (e.clientX > RAIL_W_PX + HOVER_PAD_PX) {
        if (hoveredRef.current) {
          hoveredRef.current = false;
          setHovered(false);
        }
        return;
      }
      // 藏起来时只有 X 被平移出屏，上下边界仍是显示后的位置，可以直接拿来判定
      const r = el.getBoundingClientRect();
      const inside = e.clientY >= r.top - HOVER_PAD_PX && e.clientY <= r.bottom + HOVER_PAD_PX;
      if (inside !== hoveredRef.current) {
        hoveredRef.current = inside;
        setHovered(inside);
      }
    };
    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, [autoHide]);

  // 触屏唤出:从左边缘向右划。只认边缘起手，否则看板里横向滚动的宽表格一划就误触发。
  useEffect(() => {
    if (!autoHide) return;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      startX = t.clientX;
      startY = t.clientY;
      tracking = startX <= EDGE_ZONE_PX;
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (dx >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy)) {
        tracking = false;
        setTouchRevealed(true);
      }
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
    };
  }, [autoHide]);

  // 手势唤出后没有 mouseleave 可用，只能靠「点外面」收回去
  useEffect(() => {
    if (!touchRevealed) return;
    const onDown = (e: Event) => {
      if (!railRef.current?.contains(e.target as Node)) setTouchRevealed(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [touchRevealed]);

  // 设置面板关掉时，二级的工作空间列表不该留着——下次打开会直接弹出来
  useEffect(() => {
    if (!settingsOpen) setPickerOpen(false);
  }, [settingsOpen]);

  // 点面板外或按 Escape 关设置。用 pointerdown 而不是遮罩层：
  // 遮罩会盖住工具条本身，设置开着时其它图标就点不动了。
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: Event) => {
      if (!settingsBoxRef.current?.contains(e.target as Node)) setSettingsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSettingsOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [settingsOpen]);

  return (
    <>
      <div
        ref={railRef}
        className={cn(
          // 高度由图标撑起；贴着左边，只有右侧两角圆。垂直居中的 top 由下面的 useLayoutEffect 给，
          // 不用 top-1/2 + -translate-y-1/2：那个在高度或窗口高为奇数时会算出 .5px
          'absolute left-0 z-30 flex w-[41px] flex-col items-center gap-0.5',
          'rounded-r-lg border-y border-r border-border py-1.5',
          // 常驻时也是悬浮会压住正文，所以给 85% 不透明度让下面透出来。
          // 这里**不要**加 backdrop-blur：它会把整条提成合成层重新栅格化，
          // 而垂直居中常常落在半像素上（高 223px 时 top=338.5），一重采样图标就发虚。
          'bg-background/85',
          RAIL_MOTION,
          // 藏起来时露出 8px。用 px 而不是 calc(-100%+8px)：后者和 translate-x-0 插值不成，过渡会卡住。
          // 33 = RAIL_W_PX(41) - 8，改宽度时两处一起改。
          revealed ? 'translate-x-0' : '-translate-x-[33px]',
        )}
      >
        {nav.map(({ key, label, icon: Icon }) => (
          <HeaderIconButton
            key={key}
            label={label}
            side="right"
            pressed={view === key}
            // border-transparent 常驻：选中时才上色，避免多出 1px 让图标错位
            className={cn(
              'size-8 border border-transparent',
              // 选中态实心反相：primary 在浅色是近黑、深色是近白，图标取 primary-foreground，
              // 两个主题下都是「深底浅图形」的对比关系。hover 也要盖掉 ghost 的 accent，否则一悬停就跳回灰底
              view === key &&
                'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
            )}
            onClick={() => setView(key)}
          >
            <Icon className="size-4" />
          </HeaderIconButton>
        ))}

        <RailDivider />

        <HeaderIconButton label="展开侧栏" side="right" className="size-8" onClick={onExpand}>
          <PanelLeftOpen className="size-4" />
        </HeaderIconButton>

        <div ref={settingsBoxRef} className="relative">
          <HeaderIconButton
            label="设置"
            side="right"
            pressed={settingsOpen}
            className={cn(
              'size-8 border border-transparent',
              settingsOpen && 'border-foreground/40 bg-muted hover:bg-muted',
            )}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <Settings2 className="size-4" />
          </HeaderIconButton>

          {settingsOpen ? (
            <div
              // 悬浮在工具条右侧，跟着「设置」这一格对齐
              className="absolute top-0 left-[calc(100%+0.5rem)] z-40 w-60 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
            >
              <SettingRow icon={Repeat} label="切换空间">
                <Button
                  variant="outline"
                  size="sm"
                  aria-expanded={pickerOpen}
                  onClick={() => setPickerOpen((v) => !v)}
                >
                  选择
                </Button>
              </SettingRow>
              <SettingRow icon={Moon} label="暗色模式">
                <Switch aria-label="暗色模式" checked={dark} onCheckedChange={() => toggleTheme()} />
              </SettingRow>
              <SettingRow icon={PanelLeftDashed} label="自动隐藏">
                <Switch
                  aria-label="自动隐藏工具栏"
                  checked={autoHide}
                  onCheckedChange={(next) => setAutoHide(next)}
                />
              </SettingRow>
              <SettingRow icon={RefreshCw} label="重新扫描" spinning={loading}>
                <Button variant="outline" size="sm" onClick={() => void reload()}>
                  刷新
                </Button>
              </SettingRow>
              <SettingRow icon={CircleHelp} label="查看帮助">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSettingsOpen(false);
                    openHelp();
                  }}
                >
                  查看
                </Button>
              </SettingRow>
              {/* 版本可选：老服务进程没有这个字段时整条不显示，退回改动前的样子 */}
              {version ? (
                <div className="mt-1 border-t border-border pt-2 pb-1 text-center font-mono text-[10px] text-muted-foreground/60">
                  {version}
                </div>
              ) : null}

              {/*
                工作空间二级面板：挂在设置面板右侧。它在 settingsBoxRef 之内，
                所以点它不会被「点外面关设置」那条规则误伤。
              */}
              {pickerOpen ? (
                <div className="absolute top-0 left-[calc(100%+0.5rem)] z-40 w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
                  <div className="px-2 py-1.5 text-[11px] text-muted-foreground">工作空间</div>
                  <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
                    {projects.map((project) => {
                      const broken = project.status && !project.status.ok;
                      return (
                        <button
                          key={project.id}
                          type="button"
                          title={broken ? `目录找不到了：${project.root}` : project.root}
                          onClick={() => {
                            onSelectProject(project.id);
                            setPickerOpen(false);
                            setSettingsOpen(false);
                          }}
                          className={cn(
                            'flex items-center gap-1.5 rounded-md border border-transparent px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent',
                            // 选中态同侧栏工作空间项：浅灰底 + 细深色描边
                            project.id === activeId &&
                              'border-foreground/40 bg-muted font-medium hover:bg-muted',
                          )}
                        >
                          {broken ? (
                            <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
                          ) : null}
                          <span className="truncate">{project.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
