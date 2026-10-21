import logo from '../assets/logo.svg';

/** The app mark: the glasses on a blue tile (same art as the app icon). */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <img
      src={logo}
      alt=""
      aria-hidden
      width={size}
      height={size}
      // The art has a 100px margin inside its 1024 canvas; scale it out so
      // the tile fills the box like the old square did.
      className="shrink-0 scale-[1.24] select-none"
      draggable={false}
    />
  );
}
