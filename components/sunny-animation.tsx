/**
 * Transparent looping Sunny animations (wan-generated, chroma-keyed rasters —
 * see /public/anim/sunny). Unlike `SunnyLottie` these are animated WebPs, so
 * they render with a plain <img> and cost nothing until mounted.
 *
 * Reduced motion is honored by the browser itself via a <picture> media
 * source, so SSR markup never forces the animated asset on those users.
 */
export const SUNNY_ANIMATIONS = [
  'book', 'dance', 'dig', 'files', 'grad', 'juggle', 'jump', 'laptop', 'lift',
  'music', 'oops', 'run', 'scroll', 'search', 'shrug', 'skateboard', 'sleepy',
  'soccer', 'spin', 'telescope',
] as const;

export type SunnyAnimationName = (typeof SUNNY_ANIMATIONS)[number];

export function SunnyAnimation({
  name,
  className,
}: {
  name: SunnyAnimationName;
  className?: string;
}) {
  return (
    <picture>
      <source srcSet={`/anim/sunny/${name}.still.webp`} media="(prefers-reduced-motion: reduce)" />
      <img
        src={`/anim/sunny/${name}.webp`}
        alt=""
        aria-hidden
        draggable={false}
        className={className}
      />
    </picture>
  );
}
