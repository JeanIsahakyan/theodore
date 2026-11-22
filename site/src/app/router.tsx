/**
 * A tiny router: the current path in context, `Link` for same-site
 * navigation (history.pushState, no reload), the browser's back and forward
 * through `popstate`. Each page is also prerendered to its own HTML, so a
 * first visit to /download needs none of this.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react';

interface Router {
  path: string;
  navigate: (to: string) => void;
}

const RouterContext = createContext<Router>({
  path: '/',
  navigate: () => {},
});

const NAVIGATE_EVENT = 'theodore-navigate';

export function RouterProvider({
  initialPath,
  children,
}: {
  initialPath: string;
  children: ReactNode;
}) {
  const [path, setPath] = useState(initialPath);
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener('popstate', sync);
    window.addEventListener(NAVIGATE_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(NAVIGATE_EVENT, sync);
    };
  }, []);
  const navigate = useCallback((to: string) => {
    const url = new URL(to, window.location.href);
    window.history.pushState(null, '', url);
    window.dispatchEvent(new Event(NAVIGATE_EVENT));
    if (url.hash) {
      document.getElementById(url.hash.slice(1))?.scrollIntoView();
    } else {
      window.scrollTo(0, 0);
    }
  }, []);
  return (
    <RouterContext.Provider value={{ path, navigate }}>
      {children}
    </RouterContext.Provider>
  );
}

export function useRouter(): Router {
  return useContext(RouterContext);
}

function isInternal(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//');
}

/** A link. Same-site paths navigate in place; anything else is a plain
 *  anchor (external links open in a new tab). */
export function Link({
  href,
  onClick,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const { navigate } = useRouter();
  const internal = isInternal(href);
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (
      !internal ||
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    )
      return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <a
      href={href}
      onClick={handle}
      {...(internal ? {} : { target: '_blank', rel: 'noreferrer' })}
      {...rest}
    >
      {children}
    </a>
  );
}
