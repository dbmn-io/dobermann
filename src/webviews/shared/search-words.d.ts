/** Types for core's import of search-words.js (#444: the Hub search's word rule). */
export interface SearchWordsParsed { include: string[]; exclude: string[] }
export function parseWords(text: string): SearchWordsParsed;
export function matches(parsed: SearchWordsParsed, haystack: string, extra?: (word: string) => boolean): boolean;
export function highlight(text: string, parsed: SearchWordsParsed): string;
