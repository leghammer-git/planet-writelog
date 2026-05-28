const { DateTime } = require("luxon");

module.exports = function (eleventyConfig) {
  // Passthrough
  eleventyConfig.addPassthroughCopy("public");

  // Expose build timestamp so templates can display "last updated"
  eleventyConfig.addGlobalData("buildDate", () => new Date().toISOString());

  // Filters
  eleventyConfig.addFilter("dateDisplay", (dateStr) => {
    return DateTime.fromISO(dateStr).toFormat("dd LLL yyyy");
  });

  eleventyConfig.addFilter("dateTimeUTC", (dateStr) => {
    return DateTime.fromISO(dateStr, { zone: "utc" }).toFormat("dd LLL yyyy, HH:mm 'UTC'");
  });

  eleventyConfig.addFilter("dateISO", (dateStr) => {
    return DateTime.fromISO(dateStr).toISO();
  });

  eleventyConfig.addFilter("relativeDate", (dateStr) => {
    return DateTime.fromISO(dateStr).toRelative();
  });

  eleventyConfig.addFilter("slugify", (str) => {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  });

  eleventyConfig.addFilter("limit", (arr, n) => arr.slice(0, n));

  eleventyConfig.addFilter("where", (arr, key, val) =>
    arr.filter((item) => item[key] === val)
  );

  // Feed/OPML get .xml extension
  eleventyConfig.addTemplateFormats("xml");
  eleventyConfig.addExtension("xml", { key: "njk" });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "../_data",
    },
    templateFormats: ["njk", "md", "html"],
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
  };
};
