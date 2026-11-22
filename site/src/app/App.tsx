import { useEffect } from 'react';
import { Footer } from '../components/Footer';
import { Nav } from '../components/Nav';
import { Download } from '../pages/Download';
import { Home } from '../pages/Home';
import { NotFound } from '../pages/NotFound';
import { Privacy } from '../pages/Privacy';
import { Releases } from '../pages/Releases';
import { Space } from '../pages/Space';
import { Terms } from '../pages/Terms';
import { PageDataContext, type PageData } from './data';
import { RouterProvider, useRouter } from './router';
import { routeFor } from './routes';

function Page() {
  const { path } = useRouter();
  const route = routeFor(path);
  useEffect(() => {
    document.title = route.title;
  }, [route]);
  switch (route.path) {
    case '/':
      return <Home />;
    case '/download':
      return <Download />;
    case '/releases':
      return <Releases />;
    case '/privacy':
      return <Privacy />;
    case '/terms':
      return <Terms />;
    case '/s':
      return <Space />;
    default:
      return <NotFound />;
  }
}

export function App({
  initialPath,
  data,
}: {
  initialPath: string;
  data: PageData;
}) {
  return (
    <PageDataContext.Provider value={data}>
      <RouterProvider initialPath={initialPath}>
        <div className="flex min-h-svh flex-col">
          <Nav />
          <main className="flex-1">
            <Page />
          </main>
          <Footer year={data.year} />
        </div>
      </RouterProvider>
    </PageDataContext.Provider>
  );
}
