import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import './styles.css';
import { setUnauthorizedRedirect } from './api';
import Shell from './shell';
import AuditPage from './pages/audit';
import Login from './pages/login';
import Setup from './pages/setup';
import AnnouncementPage from './pages/announcement';
import Dashboard from './pages/dashboard';
import ContentPage from './pages/content';
import DownloadsPage from './pages/downloads';
import FaqPage from './pages/faq';
import LegalPage from './pages/legal';
import PublishPage from './pages/publish';
import SeoPage from './pages/seo';
import SkusPage from './pages/skus';
import StatsPage from './pages/stats';
import GeoPage from './pages/geo';
import LanguagesPage from './pages/languages';
import AiPage from './pages/ai';

const router = createBrowserRouter(
  [
    { path: '/login', element: <Login /> },
    { path: '/setup', element: <Setup /> },
    {
      path: '/',
      element: <Shell />,
      children: [
        { index: true, element: <Dashboard /> },
        { path: 'content', element: <ContentPage /> },
        { path: 'content/languages', element: <LanguagesPage /> },
        { path: 'ai', element: <AiPage /> },
        { path: 'content/downloads', element: <DownloadsPage /> },
        { path: 'content/stats', element: <StatsPage /> },
        { path: 'content/skus', element: <SkusPage /> },
        { path: 'content/faq', element: <FaqPage /> },
        { path: 'content/announcement', element: <AnnouncementPage /> },
        { path: 'content/seo', element: <SeoPage /> },
        { path: 'content/legal', element: <LegalPage /> },
        { path: 'geo', element: <GeoPage /> },
        { path: 'publish', element: <PublishPage /> },
        { path: 'audit', element: <AuditPage /> },
        { path: '*', element: <section><h2>页面不存在</h2><p className="kv">左侧导航可回到任意模块。</p></section> },
      ],
    },
  ],
  { basename: '/admin' },
);

/* 401 用路由跳转,不整页重载(实景走查 P2-9:三个并发探针 401 会连着触发三次整页导航,
   控制台留下一串 ERR_ABORTED,还白白重下一次 bundle)。 */
setUnauthorizedRedirect((to) => router.navigate(to, { state: { bypassUnsaved: true } }));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
