import bundledSite from '../config/site.json';
import { loadBuildFixture } from './build-fixture';

export interface LocalizedText {
  en: string;
  vi: string;
  zh: string;
}

export interface SiteConfig {
  schemaVersion: number;
  stats: {
    activeDevices: number;
    activeJobs: number;
    nodes: number;
    countries: number;
    uptime: number;
    asOf: string;
    growth?: {
      enabled: boolean;
      since: string;
      daily: Record<'activeDevices' | 'activeJobs' | 'nodes' | 'countries', number>;
    };
  };
  skus: unknown[];
  downloads: Record<'ios' | 'android' | 'h5', { url: string; enabled: boolean }>;
  announcement: {
    id: string;
    enabled: boolean;
    text: LocalizedText;
    href?: string;
    startsAt?: string;
    endsAt?: string;
  };
  seo: {
    pages: Record<string, { title: LocalizedText; description: LocalizedText }>;
  };
  footer: {
    social: Array<{ id: string; url: string; enabled: boolean }>;
    contactEmail: string;
  };
  legal?: Record<'terms' | 'privacy' | 'appPrivacy', { md: LocalizedText; updatedAt: string }>;
}

export const SITE_CONFIG = loadBuildFixture<SiteConfig>('site.json', bundledSite as SiteConfig);
