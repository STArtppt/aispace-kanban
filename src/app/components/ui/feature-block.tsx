import type { ComponentProps, ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * A single feature stated as a card: optional badge, headline, and a body that
 * stays out of the way until asked for. Built on Collapsible, so the expand
 * behaviour, height transition and aria wiring have one implementation.
 *
 * Closed by default — the headline is the whole point, the body is the detail.
 * Pass defaultOpen to start expanded, or open + onOpenChange to control it.
 *
 * Composition:
 *   FeatureBlock > FeatureBlockTrigger + FeatureBlockPanel > FeatureBlockContent
 *
 * Not an accordion: blocks in a grid expand independently, and a feature list
 * where opening one closes another reads as a quiz, not a spec. Not a dialog —
 * the body stays in flow, so no z-index.
 */

type FeatureBlockProps = ComponentProps<typeof Collapsible>;

function FeatureBlock({ className, ...props }: FeatureBlockProps) {
  return (
    <Collapsible
      data-slot="feature-block"
      // overflow-hidden so the trigger's hover fill is clipped to the card
      // radius — the trigger itself carries no corners of its own.
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-background",
        className,
      )}
      {...props}
    />
  );
}

type FeatureBlockTriggerProps = Omit<
  ComponentProps<typeof CollapsibleTrigger>,
  "children"
> & {
  /** Optional chip above the title (e.g. <Badge>NEW</Badge>). Omitted cleanly. */
  badge?: ReactNode;
  title: ReactNode;
};

/**
 * The whole header is the hit target, not just the chevron — a 16px arrow is a
 * poor thing to aim at, and the title is what people read first anyway.
 */
function FeatureBlockTrigger({
  className,
  badge,
  title,
  ...props
}: FeatureBlockTriggerProps) {
  return (
    <CollapsibleTrigger
      data-slot="feature-block-trigger"
      className={cn(
        "items-start gap-3 rounded-none px-5 py-4",
        // Own hover surface, so it also owns the text colour: the inherited
        // hover:text-accent-foreground belongs to Collapsible's bg-accent pair.
        "hover:bg-muted/50 hover:text-foreground",
        // ring-inset: the trigger sits flush against the card edge, so an
        // offset ring would be drawn outside the border.
        "focus-visible:ring-inset focus-visible:ring-offset-0",
        className,
      )}
      {...props}
    >
      <span className="flex min-w-0 flex-col items-start gap-2">
        {badge}
        <span className="text-lg leading-snug font-medium text-foreground">
          {title}
        </span>
      </span>
      <ChevronDown
        className={cn(
          "mt-0.5 size-4 shrink-0 text-muted-foreground",
          "transition-transform duration-150 ease-out",
          "group-data-panel-open:rotate-180 motion-reduce:transition-none",
        )}
        aria-hidden
      />
    </CollapsibleTrigger>
  );
}

type FeatureBlockPanelProps = ComponentProps<typeof CollapsiblePanel>;

function FeatureBlockPanel({ className, ...props }: FeatureBlockPanelProps) {
  return (
    <CollapsiblePanel
      data-slot="feature-block-panel"
      // The rule lives on the panel, not the content wrapper, so it is there
      // even when a consumer supplies its own body. Full-bleed: it separates
      // the two halves of the card, so it runs edge to edge rather than
      // sitting inside the text column. Closed = unmounted, so no stray line.
      className={cn("border-t border-border", className)}
      {...props}
    />
  );
}

/**
 * Padding lives here, not on the Panel — the Panel animates height and must be
 * free to reach 0.
 *
 * Top padding is deliberately larger than the trigger's: the body needs to sit
 * clear of the rule above it, or the card reads as one cramped block instead of
 * a headline and its detail.
 */
function FeatureBlockContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="feature-block-content"
      className={cn("px-5 py-5 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  FeatureBlock,
  FeatureBlockTrigger,
  FeatureBlockPanel,
  FeatureBlockContent,
  type FeatureBlockProps,
  type FeatureBlockTriggerProps,
  type FeatureBlockPanelProps,
};
