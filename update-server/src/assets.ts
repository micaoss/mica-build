import js from '../.generated/client.js' with { type: 'text' }
import html from '../web/index.html' with { type: 'text' }
import css from '../web/style.css' with { type: 'text' }

// Bun's text loader returns a string; its default HTML import type is a bundle.
export const assets = { html: String(html), css, js }
