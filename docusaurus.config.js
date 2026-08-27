// @ts-check
const { themes: prismThemes } = require("prism-react-renderer");

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "FTD.aero Manuals",
  tagline: "Generated per simulator from its installed configuration",
  favicon: "img/favicon.ico",
  url: "https://docs.ftd.aero",
  baseUrl: "/",
  organizationName: "ftd-aero",
  projectName: "ftd-docs",
  onBrokenLinks: "throw",
  markdown: { hooks: { onBrokenMarkdownLinks: "throw" } },
  i18n: { defaultLocale: "en", locales: ["en"] },
  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          path: "docs",
          routeBasePath: "manuals",
          sidebarPath: "./sidebars.js",
          exclude: ["**/manifest.json", "**/manuals.json"],
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      }),
    ],
  ],
  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: { respectPrefersColorScheme: true },
      navbar: {
        title: "FTD.aero Manuals",
        items: [{ to: "/", label: "All simulators", position: "left" }],
      },
      footer: {
        style: "dark",
        copyright: `© ${new Date().getFullYear()} FTD.aero Sp. z o.o. Proprietary — generated documentation.`,
      },
      prism: { theme: prismThemes.github, darkTheme: prismThemes.dracula },
    }),
};

module.exports = config;
