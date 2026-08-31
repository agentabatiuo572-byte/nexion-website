import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import './styles.css';
import Shell from './shell';
import AuditPage from './pages/audit';
import Login from './pages/login';
import Setup from './pages/setup';
import AnnouncementPage from './pages/announcement';
import ContentPage from './pages/content';
import DownloadsPage from './pages/downloads';
import FaqPage from './pages/faq';
import LegalPage from './pages/legal';
import SeoPage from './pages/seo';
import SkusPage from './pages/skus';
import StatsPage from './pages/stats';
import { DashboardStub, GeoStub, PublishStub } from './pages/stubs';

const router = createBrowserRouter(
  [
    { path: '/login', element: <Login /> },
    { path: '/setup', element: <Setup /> },
    {
      path: '/',
      element: <Shell />,
      children: [
        { index: true, element: <DashboardStub /> },
        { path: 'content', element: <ContentPage /> },
        { path: 'content/downloads', element: <DownloadsPage /> },
        { path: 'content/stats', element: <StatsPage /> },
        { path: 'content/skus', element: <SkusPage /> },
        { path: 'content/faq', element: <FaqPage /> },
        { path: 'content/announcement', element: <AnnouncementPage /> },
        { path: 'content/seo', element: <SeoPage /> },
        { path: 'content/legal', element: <LegalPage /> },
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
