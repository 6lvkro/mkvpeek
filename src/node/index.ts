/**
 * The Node.js entry point.
 *
 * The whole browser surface, with this entry's own two that take a path and a urlSource that reads over node:http.
 */

export * from "../index.js";
export { openContainer, peekTracks } from "./entry.js";
export { urlSource } from "./http.js";
