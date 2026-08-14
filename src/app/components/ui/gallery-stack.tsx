import * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * One card that stands for a whole pile of media: a cover plus offset pads
 * behind it, so a collection reads as "there is more in here" without a
 * carousel. Static by design — no autoplay, no fan-out on hover.
 *
 * Depth is faked with border + muted fills (the elevation rule: no shadows on
 * static surfaces), and the pads only rotate — the stage keeps 8px of padding
 * so rotated corners never clip.
 *
 * Renders a <button> by default (a pile is something you open); pass
 * `render={<div />}` for a display-only card.
 */
const galleryStackVariants = cva(
  "group flex w-full min-w-0 flex-col gap-2 text-left outline-none",
  {
    variants: {
      // Cards stay card-sized instead of stretching with the grid: a pile is a
      // thumbnail, not a hero. max-w keeps them shrinkable on narrow screens.
      size: {
        sm: "max-w-32",
        md: "max-w-44",
        lg: "max-w-56",
      },
    },
    defaultVariants: {
      size: "md",
    },
  },
);

const coverVariants = cva(
  "relative overflow-hidden rounded-lg border border-border bg-muted transition-colors group-hover:border-primary/40 group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-background group-data-[selected]:border-primary [&_img]:size-full [&_img]:object-cover",
  {
    variants: {
      ratio: {
        landscape: "aspect-[4/3]",
        square: "aspect-square",
        portrait: "aspect-[3/4]",
      },
    },
    defaultVariants: {
      ratio: "landscape",
    },
  },
);

/** At most two pads: a third adds no information and starts to look messy. */
const MAX_PADS = 2;

function padCount(count: number | undefined): number {
  if (count == null) return MAX_PADS;
  return Math.min(MAX_PADS, Math.max(0, count - 1));
}

type GalleryStackProps = Omit<
  useRender.ComponentProps<"button">,
  "title" | "children"
> &
  VariantProps<typeof galleryStackVariants> &
  VariantProps<typeof coverVariants> & {
    /** Cover media — usually an `<img>`; it is sized to fill the frame. */
    cover?: React.ReactNode;
    /**
     * How many items the pile holds. Drives how many pads show behind the
     * cover (0 → none, 1 → one, 2+ → two). Omit to always draw two.
     */
    count?: number;
    /** Primary line under the cover. */
    title?: React.ReactNode;
    /** Secondary line — count, size, source. */
    caption?: React.ReactNode;
    /** Current / open pile. Exposed as `data-selected` for styling. */
    selected?: boolean;
  };

const GalleryStack = React.forwardRef<HTMLButtonElement, GalleryStackProps>(
  (
    {
      className,
      size,
      ratio,
      cover,
      count,
      title,
      caption,
      selected,
      render,
      ...props
    },
    ref,
  ) => {
    const pads = padCount(count);

    return useRender({
      render: render ?? <button type="button" />,
      ref,
      state: { selected: Boolean(selected) },
      props: {
        "data-slot": "gallery-stack",
        className: cn(galleryStackVariants({ size }), className),
        ...props,
        children: (
          <>
            {/*
              Stage: the padding is the room rotated pads stick out into. Pads
              share the cover's box (inset-3) and only rotate — at thumbnail
              size anything gentler than ~3° stops reading as a pile.
            */}
            <div data-slot="gallery-stack-deck" className="relative p-3">
              {pads >= MAX_PADS ? (
                <div
                  aria-hidden
                  data-slot="gallery-stack-pad"
                  className="absolute inset-3 -rotate-6 rounded-lg border border-border bg-muted/60"
                />
              ) : null}
              {pads >= 1 ? (
                <div
                  aria-hidden
                  data-slot="gallery-stack-pad"
                  className="absolute inset-3 rotate-3 rounded-lg border border-border bg-muted/80"
                />
              ) : null}
              <div
                data-slot="gallery-stack-cover"
                className={cn(coverVariants({ ratio }))}
              >
                {cover}
              </div>
            </div>
            {title != null || caption != null ? (
              <div
                data-slot="gallery-stack-meta"
                className="flex min-w-0 flex-col px-2"
              >
                {title != null ? (
                  <span className="truncate text-sm">{title}</span>
                ) : null}
                {caption != null ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {caption}
                  </span>
                ) : null}
              </div>
            ) : null}
          </>
        ),
      },
    });
  },
);
GalleryStack.displayName = "GalleryStack";

export {
  GalleryStack,
  galleryStackVariants,
  coverVariants as galleryStackCoverVariants,
  type GalleryStackProps,
};
