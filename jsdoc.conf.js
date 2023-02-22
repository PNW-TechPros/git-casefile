exports.plugins = [
  'plugins/markdown',
];

exports.source = {
  include: ['src'],
};

exports.opts = {
  template: 'node_modules/docdash',
  // tutorials: 'expositions',
};

exports.docdash = {
  sectionOrder: [
    "Modules",
    "Namespaces",
    "Interfaces",
    "Classes",
    "Mixins",
    "Events",
    "Externals",
    "Tutorials",
  ],
  scripts: [
    'styles/pkg-custom.css',
  ],
  menu: {
    "select version": {
      href: "../versions.html",
      class: "menu-item version-select",
      id: "other_versions",
    },
  },
};

exports.templates = {
  default: {
    staticFiles: {
      include: [
        'scripts/docs/content',
      ],
    },
  },
};
