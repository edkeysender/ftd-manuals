/** Helpers shared by the store and the pure modules that must not import it (it opens the repo on load). */
export const slugify = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
