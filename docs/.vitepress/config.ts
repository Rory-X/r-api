import { defineConfig } from 'vitepress';

const docsBase = '/r-api/';

export default defineConfig({
  lang: 'zh-CN',
  title: 'r-api 文档',
  description: 'r-api 使用文档、FAQ 与维护协作指南',
  base: docsBase,
  head: [
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: `${docsBase}favicon.png` }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '64x64', href: `${docsBase}favicon-64.png` }],
    ['link', { rel: 'shortcut icon', href: `${docsBase}favicon.ico` }],
  ],
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['plans/**'],
  themeConfig: {
    siteTitle: 'r-api Docs',
    logo: '/logos/logo-icon-512.png',
    nav: [
      { text: '首页', link: '/' },
      { text: '快速上手', link: '/getting-started' },
      {
        text: '接入指南',
        items: [
          { text: '上游渠道接入', link: '/upstream-integration' },
          { text: '官方凭证池', link: '/oauth' },
          { text: '浏览器凭证', link: '/browser-extension' },
          { text: '客户端接入', link: '/client-integration' },
        ],
      },
      {
        text: '部署与运维',
        items: [
          { text: '部署指南', link: '/deployment' },
          { text: '配置说明', link: '/configuration' },
          { text: '运维手册', link: '/operations' },
          { text: 'Local Connector', link: '/local-connector' },
        ],
      },
      { text: 'FAQ', link: '/faq' },
      { text: '项目主页', link: 'https://github.com/Rory-X/r-api' },
    ],
    sidebar: [
      {
        text: '开始',
        items: [
          { text: '文档首页', link: '/' },
          { text: '快速上手', link: '/getting-started' },
          { text: '部署指南', link: '/deployment' },
        ],
      },
      {
        text: '上游接入',
        items: [
          { text: '渠道管理与上游接入', link: '/upstream-integration' },
          { text: '官方凭证池', link: '/oauth' },
          { text: '浏览器凭证扩展', link: '/browser-extension' },
          { text: '完整功能使用指南', link: '/fork-features-guide' },
        ],
      },
      {
        text: '路由与客户端',
        items: [
          { text: '客户端接入', link: '/client-integration' },
          { text: '配置说明', link: '/configuration' },
          { text: '管理 API', link: '/management-api' },
        ],
      },
      {
        text: '部署与运维',
        items: [
          { text: 'Local Connector', link: '/local-connector' },
          { text: 'K3s 更新中心（高级）', link: '/k3s-update-center' },
          { text: '运维手册', link: '/operations' },
          { text: '常见问题 FAQ', link: '/faq' },
        ],
      },
      {
        text: '文档维护',
        items: [
          { text: '文档维护与贡献', link: '/README' },
          { text: '目录规范', link: '/project-structure' },
          { text: 'FAQ/教程贡献规范', link: '/community/faq-tutorial-guidelines' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Rory-X/r-api' },
    ],
    outline: {
      level: [2, 3],
    },
    footer: {
      message: 'MIT Licensed',
      copyright: 'Copyright (c) 2026 r-api Contributors',
    },
    search: {
      provider: 'local',
    },
  },
});
