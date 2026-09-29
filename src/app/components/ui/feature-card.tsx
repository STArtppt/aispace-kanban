import * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Hairline plus that sits on a corner so a card reads as a drafting-board
 * tile rather than a rounded box. Pair with FeatureCard; the four-position
 * variants exist so a surrounding frame can mark every intersection.
 */
const decorIconVariants = cva(
  "pointer-events-none absolute z-1 size-5 shrink-0 stroke-1 stroke-muted-foreground",
  {
    variants: {
      position: {
        "top-left":
          "top-0 left-0 -translate-x-[calc(50%+0.5px)] -translate-y-[calc(50%+0.5px)]",
        "top-right":
          "top-0 right-0 translate-x-[calc(50%+0.5px)] -translate-y-[calc(50%+0.5px)]",
        "bottom-right":
          "right-0 bottom-0 translate-x-[calc(50%+0.5px)] translate-y-[calc(50%+0.5px)]",
        "bottom-left":
          "bottom-0 left-0 -translate-x-[calc(50%+0.5px)] translate-y-[calc(50%+0.5px)]",
      },
    },
    defaultVariants: {
      position: "top-left",
    },
  },
);

type DecorIconProps = React.ComponentProps<"svg"> &
  VariantProps<typeof decorIconVariants>;

function DecorIcon({ position, className, ...props }: DecorIconProps) {
  return (
    <svg
      aria-hidden="true"
      className={cn(decorIconVariants({ position, className }))}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

/**
 * One module stated as a drafting-board tile: icon, title, optional trailing
 * meta, and a short description, framed by hairlines that overhang the box
 * so neighbouring cards can share a grid.
 *
 * Renders a <button> by default (a module is something you open) with
 * cursor-pointer. Pass `render={<div />}` for a display-only tile, or
 * `render={<a href="…" />}` to navigate.
 *
 * Depth comes from 1px hairlines, never shadow. No z-index (in flow).
 *
 * Composition:
 *   FeatureCardGrid > FeatureCard
 *
 * The grid's gap-8 is load-bearing: each card's horizontal hairlines extend
 * 16px, so a 32px gutter lets neighbours meet in the middle.
 */
type FeatureCardProps = Omit<
  useRender.ComponentProps<"button">,
  "title" | "children"
> & {
  /** Leading pictogram, usually a lucide icon. Sized by the tile. */
  icon?: React.ReactNode;
  /** Primary line. */
  title: React.ReactNode;
  /** Short supporting copy under the title. */
  description?: React.ReactNode;
  /** Trailing slot on the title row — a count, a status, nothing. */
  meta?: React.ReactNode;
};

const FeatureCard = React.forwardRef<HTMLButtonElement, FeatureCardProps>(
  (
    { className, icon, title, description, meta, render, ...props },
    ref,
  ) => {
    const interactive = render == null;

    return useRender({
      render: render ?? <button type="button" />,
      ref,
      props: {
        "data-slot": "feature-card",
        className: cn(
          "relative flex flex-col justify-between gap-6 bg-background px-6 pt-8 pb-6 text-left",
          "dark:bg-[radial-gradient(50%_80%_at_25%_0%,--theme(--color-foreground/.1),transparent)]",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:pointer-events-none disabled:opacity-50",
          interactive && "cursor-pointer",
          className,
        ),
        ...props,
        children: (
          <>
            <div
              aria-hidden
              data-slot="feature-card-rule"
              className="absolute -inset-y-4 -left-px w-px bg-border"
            />
            <div
              aria-hidden
              data-slot="feature-card-rule"
              className="absolute -inset-y-4 -right-px w-px bg-border"
            />
            <div
              aria-hidden
              data-slot="feature-card-rule"
              className="absolute -inset-x-4 -top-px h-px bg-border"
            />
            <div
              aria-hidden
              data-slot="feature-card-rule"
              className="absolute -right-4 -bottom-px -left-4 h-px bg-border"
            />
            <DecorIcon className="size-3.5" position="top-left" />

            {icon != null ? (
              <div
                data-slot="feature-card-icon"
                className={cn(
                  "relative z-10 flex w-fit items-center justify-center rounded-lg border bg-muted/20 p-3",
                  "[&_svg]:size-5 [&_svg]:stroke-[1.5] [&_svg]:text-foreground",
                )}
              >
                {icon}
              </div>
            ) : null}

            <div data-slot="feature-card-body" className="relative z-10 space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-base text-foreground">{title}</span>
                {meta != null ? meta : null}
              </div>
              {description != null ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {description}
                </p>
              ) : null}
            </div>
          </>
        ),
      },
    });
  },
);
FeatureCard.displayName = "FeatureCard";

type FeatureCardGridProps = React.ComponentProps<"div">;

/**
 * Gap is 32px on purpose: FeatureCard hairlines overhang 16px, so adjacent
 * tiles meet in the gutter. Column count is the caller's — pass sm/lg cols
 * via className.
 */
function FeatureCardGrid({ className, ...props }: FeatureCardGridProps) {
  return (
    <div
      data-slot="feature-card-grid"
      className={cn("grid grid-cols-1 gap-8", className)}
      {...props}
    />
  );
}

export {
  FeatureCard,
  FeatureCardGrid,
  DecorIcon,
  decorIconVariants,
  type FeatureCardProps,
  type FeatureCardGridProps,
  type DecorIconProps,
};
