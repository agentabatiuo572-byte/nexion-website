import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import './styles.css';
import Shell from './shell';
import AuditPage from './pages/audit';
import Login from './pages/login';
import Setup from './pages/setup';
import { AnnouncementStub, ContentStub, DashboardStub, DownloadsStub, FaqStub, GeoStub, LegalStub, PublishStub, SeoStub, SkusStub, StatsStub } from './pages/stubs';

const router = createBrowserRouter(
  [
    { path: '/login', element: <Login /> },
    { path: '/setup', element: <Setup /> },
    {
      path: '/',
      element: <Shell />,
      children: [
        { index: true, element: <DashboardStub /> },
        { path: 'content', element: <ContentStub /> },
        { path: 'content/downloads', element: <DownloadsStub /> },
        { path: 'content/stats', element: <StatsStub /> },
        { path: 'content/skus', element: <SkusStub /> },
        { path: 'content/faq', element: <FaqStub /> },
        { path: 'content/announcement', element: <AnnouncementStub /> },
        { path: 'content/seo', element: <SeoStub /> },
        { path: 'content/legal', element: <LegalStub /> },
        { path: 'geo', element: <GeoStub /> },
        { path: 'publish', element: <PublishStub /> },
        { path: 'audit', element: <AuditPage /> },
        { path: '*', element: <section><h2>页面不存在</h2><p className="kv">左侧导航可回到任意模块。</p></section> },
      ],
    },
  ],
  { basename: '/admin' },
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
