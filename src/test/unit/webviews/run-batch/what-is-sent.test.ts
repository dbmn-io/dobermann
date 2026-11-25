// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * What Run Batch SENDS, from a file's cell to the request body, through the real pieces in the order a run uses them
 * (2026-11-25: the design system's reading of Map found claims of wrong values sent; these reproduce them first):
 *   1. Map's sample: the page's computeTargetSample (the TARGET SAMPLE column the user reads)
 *   1b. Next to Validate: each column's Source format, then a datetime column's Change time zone (the file's timezone to
 *      the environment's Target), into the grid
 *   2. Execute, host: FormatConverterService.applyDataTransformations (run-batch.controller handleApplyTypeTransformations)
 *   3. Execute, page: DTTypeCoercion.handleTypeTransformationResult builds jsonData (each column's Source format applied
 *      again by convertValueBySourceFormat) and posts executeBulkLoadCommand
 *   4. The request: JsonGenerator.generateSingleRowJson with the batch member handler's options
 * A variable and its column share a name, as auto-map leaves them. Each case says what Map shows and what is sent.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { FormatConverterService } from '../../../../services/format-converter/format-converter.service';
import { DataTypeDetectionService } from '../../../../services/data-type-detection/data-type-detection.service';
import { DataTransformationService } from '../../../../services/data-transformation/data-transformation.service';
import { JsonGenerator } from '../../../../data-loading/json-generator';
import { dateOrderOf } from '../../../../data-loading/date-order';

const SHARED = path.resolve(__dirname, '../../../../../src/webviews/shared');
const SCRIPTS = ['dbmn-toast.js', 'json-comment-stripper.js', 'template-rename.js', 'dt-data-entry-grid.js', 'dt-type-coercion.js',
    'dt-data-ingestion.js', 'dt-data-preview.js', 'dt-mismatch-repair.js', 'dt-batch-config.js', 'data-transformer.js'];

/** locale: this computer's, as the host sends its date order (currentEnvironmentData); none: not known yet */
/** timezone: Map's File's timezone (none: this computer's); target: the environment's Target timezone (none: UTC) */
interface Case { type: string; modifier?: string; format: string; value: string; timezone?: string; locale?: string; target?: string }
interface Result { mapShows: string; mapSays: string | null; validateHolds: string; validateSays: string | null; sent: unknown; fails?: string }

async function run({ type, modifier, format, value, timezone, locale, target }: Case): Promise<Result> {
    const dom = new JSDOM('<!DOCTYPE html><body><button id="csvExecuteBtn">Execute</button></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window as any;
    const posted: any[] = [];
    w.vscode = { postMessage: (m: any) => posted.push(m) };
    for (const file of SCRIPTS) w.eval(fs.readFileSync(path.join(SHARED, file), 'utf8'));
    const spec = modifier ? `${type}|${modifier}` : type;
    const body = JSON.stringify({ v: `{{v:${spec}}}` });
    const variable = { name: 'v', dataType: type, mappedTo: 'v', formatModifier: modifier || '' };
    w.CSVHandler.setState({
        modalStep: 2, rawCSVContent: `v\n${JSON.stringify(value)}`, templateVariables: [variable], sourceTypes: { v: format },
        selectedColumnTypes: { v: type }, batchName: 'Test', ...(timezone ? { sourceTimezone: timezone } : {}),
        ...(target ? { currentEnvironment: { targetTimezone: target } } : {}),
        ...(locale ? { systemDateOrder: { order: dateOrderOf(locale), locale } } : {})
    });
    // 1. Map (Step 2): the TARGET SAMPLE the user reads
    w.CSVHandler.setState({ currentHeaders: ['v'], currentParsedData: { headers: ['v'], rows: [[value]] } });
    const mapShows = String(w.CSVHandler.computeTargetSample(value, 'v', type));
    const issue = w.CSVHandler.checkForActualIssues(value, format, type, 'v');
    const mapSays = issue ? String(issue.summary) : null;
    // 2. Next to Validate (Step 2 → 3): the rows converted by each column's Source format, into the grid
    const validateHolds = String(w.DTTypeCoercion.applySourceFormatToRows(['v'], [[value]], [variable])[0][0]);
    // ...and Validate's checks of that row: a row it stops is never sent
    w.CSVHandler.setState({ gridTemplateVariables: [{ name: 'v', dataType: type, modifiers: w.DTDataEntryGrid.parseModifiersForGrid(modifier || '', type) }] });
    const errors = w.DTDataEntryGrid.validateDataModelRow([validateHolds], 0) as Array<{ error: string }>;
    const validateSays = errors.length ? String(errors[0].error) : null;
    if (validateSays) return { mapShows, mapSays, validateHolds, validateSays, sent: undefined };
    // 3. Next to Review (Step 3 → 4, useGridAsSource): the grid is the data from here on
    const gridCSV = `v\n${JSON.stringify(validateHolds)}`;
    w.CSVHandler.setState({ modalStep: 4, rawCSVContent: gridCSV, sourceType: 'grid', executeAfterTransform: true, executionEndpointId: 'ep-1' });
    // 4. Execute, host: the whole file's transform (the page's non-string column types)
    const converter = new FormatConverterService(new DataTypeDetectionService(), new DataTransformationService());
    const nonString = w.DTTypeCoercion.filterNonStringTypes({ v: type });
    const transformed = await converter.applyDataTransformations(gridCSV, new Map(Object.entries(nonString)) as never);
    // 5. Execute, page: what it sends (each column's Source format applied by headerFormatMap)
    w.DTTypeCoercion.handleTypeTransformationResult({ transformedData: transformed });
    const execute = posted.find(m => m.type === 'executeBulkLoadCommand');
    if (!execute) throw new Error('nothing sent: ' + JSON.stringify(posted.map(m => m.type)));
    const row = execute.jsonData[0] as Record<string, string>;
    // 6. The request body, as batch-member-transaction.handler builds it: a column per variable typed 'string' (the
    //    template's own types do the rest), the row joined with commas; the run's source timezone is not passed
    const generated = await new JsonGenerator().generateSingleRowJson([String(row.v ?? '')].join(','), {
        template: body, mappings: [{ variable: 'v', column: 'v', dataType: 'string' }], headers: ['v'], repeatableArrays: [],
        endpointId: 'ep-1', sequenceStartValue: 1001, isBatchExecution: true
    } as never);
    if (!generated.success) return { mapShows, mapSays, validateHolds, validateSays, sent: undefined, fails: String(generated.error) };
    const json = generated.jsonData as unknown;
    const first = (Array.isArray(json) ? json[0] : json) as Record<string, unknown>;
    return { mapShows, mapSays, validateHolds, validateSays, sent: first.v };
}

/** A date sent, as its digits (the default output is YYYYMMDD): what day it says. */
const dayOf = (sent: unknown) => String(sent ?? '').replace(/\D/g, '').slice(0, 8);

const report: string[] = [];
const say = (label: string, c: Case, r: Result) => report.push(`${label} | ${c.type}${c.modifier ? '|' + c.modifier : ''} | ${c.format}${c.timezone ? ' ' + c.timezone : ''} | "${c.value}" | Map: ${r.mapShows}${r.mapSays ? ' (' + r.mapSays + ')' : ''} | Validate: ${r.validateHolds}${r.validateSays ? ' STOPS: ' + r.validateSays : ''} | sent: ${r.validateSays ? '(not sent)' : r.fails ? 'FAILS ' + r.fails : JSON.stringify(r.sent)}`);

/**
 * What the same cell was sent as before the time zone moved to Map: the page converted nothing for a datetime with
 * the default Source format, Execute's type transform read the cell, and the request builder built it. The host's code
 * is unchanged by that move, so this replays today's path as it is.
 */
async function sentBefore(value: string, modifier?: string): Promise<unknown> {
    const converter = new FormatConverterService(new DataTypeDetectionService(), new DataTransformationService());
    const cell = (await converter.applyDataTransformations(`v\n${JSON.stringify(value)}`, new Map([['v', 'datetime']]) as never)).split('\n')[1];
    const spec = modifier ? `datetime|${modifier}` : 'datetime';
    const generated = await new JsonGenerator().generateSingleRowJson(cell, {
        template: JSON.stringify({ v: `{{v:${spec}}}` }), mappings: [{ variable: 'v', column: 'v', dataType: 'string' }], headers: ['v'],
        repeatableArrays: [], endpointId: 'ep-1', sequenceStartValue: 1001, isBatchExecution: true
    } as never);
    return generated.success ? (generated.jsonData as Record<string, unknown>).v : undefined;
}

describe('What Run Batch sends: a cell, through Map, Validate, Execute and the request build', function () {
    this.timeout(30_000);
    after(() => { console.log(`\n[TZ=${process.env.TZ || 'local'}]\n` + report.join('\n')); });

    describe('1. dates: sent as the day the file means, YYYY-MM-DD, and Map shows that day', () => {
        const readable: Array<[string, string, string]> = [
            ['yyyy-mm-dd', '2024-01-05', '2024-01-05'], ['mm-dd-yyyy', '01/05/2024', '2024-01-05'], ['dd-mm-yyyy', '05/01/2024', '2024-01-05'],
            ['dd-mm-yyyy', '25/01/2024', '2024-01-25'], ['unix_timestamp', '1704412800', '2024-01-05'], ['iso_8601', '2024-01-05T00:00:00Z', '2024-01-05'],
            ['iso_8601', '2024-01-05T23:30:00-08:00', '2024-01-05'], ['auto_date', '25/01/2024', '2024-01-25'], ['auto_date', '2024-01-05', '2024-01-05'],
            ['excel_serial', '45296', '2024-01-05']
        ];
        for (const [format, value, day] of readable) {
            it(`${format} "${value}": Map shows ${day}, and ${day.replace(/-/g, '')} is sent`, async () => {
                const c = { type: 'date', format, value };
                const r = await run(c);
                say('1 date', c, r);
                expect(r.mapShows, 'what Map shows is what is sent').to.equal(day);
                expect(r.validateSays, 'Validate lets it through').to.equal(null);
                expect(dayOf(r.sent), r.fails || `sent ${JSON.stringify(r.sent)}`).to.equal(day.replace(/-/g, ''));
            });
        }
        it('a date the format can\'t read stops on Validate, naming the format; Map says so first; nothing is sent', async () => {
            const c = { type: 'date', format: 'dd-mm-yyyy', value: '31/02/2024' };
            const r = await run(c);
            say('1 date', c, r);
            expect(r.mapSays).to.equal('Not a date in DD/MM/YYYY');
            expect(r.validateSays).to.match(/^not a date in DD\/MM\/YYYY/);
            expect(r.sent).to.equal(undefined);
        });
        it('Auto-detect on a column where every day could be a month: Map asks which, Validate stops it, nothing is guessed', async () => {
            const c = { type: 'date', format: 'auto_date', value: '05/01/2024' };
            const r = await run(c);
            say('1 date', c, r);
            expect(r.mapShows, 'not converted').to.equal('05/01/2024');
            expect(r.mapSays).to.match(/^Day or month first\?/);
            expect(r.validateSays).to.match(/^day or month first\?/);
            expect(r.sent).to.equal(undefined);
        });
    });

    describe('1a. dates: a column that could be either is read in this computer\'s date order, and Map says so', () => {
        // James, 2026-11-25: "Not US style, we should read it from the system preferences … System must be predictable"
        const said = (first: string) => `Read ${first} first (this computer's date setting). Choose a format to change it.`;
        const cases: Array<[string, string, string, string | null]> = [
            ['en-AU', '05/01/2024', '2024-01-05', said('day')],
            ['en-GB', '05/01/2024', '2024-01-05', said('day')],
            ['en-US', '05/01/2024', '2024-05-01', said('month')],
            // a day over 12 settles it from the data, whatever the computer says, and nothing is said
            ['en-US', '25/01/2024', '2024-01-25', null],
            ['en-AU', '01/25/2024', '2024-01-25', null]
        ];
        for (const [locale, value, day, mapSays] of cases) {
            it(`${locale}, Auto-detect "${value}": ${day} is shown and sent${mapSays ? ', and Map says how it was read' : ''}`, async () => {
                const c = { type: 'date', format: 'auto_date', value, locale };
                const r = await run(c);
                say('1a date', c, r);
                expect(r.mapShows).to.equal(day);
                expect(r.mapSays).to.equal(mapSays);
                expect(r.validateSays).to.equal(null);
                expect(dayOf(r.sent), r.fails || `sent ${JSON.stringify(r.sent)}`).to.equal(day.replace(/-/g, ''));
            });
        }
        it('a format chosen on Map wins over the computer: DD/MM/YYYY on an en-US computer', async () => {
            const c = { type: 'date', format: 'dd-mm-yyyy', value: '05/01/2024', locale: 'en-US' };
            const r = await run(c);
            say('1a date', c, r);
            expect(r.mapShows).to.equal('2024-01-05');
            expect(r.mapSays).to.equal(null);
            expect(dayOf(r.sent)).to.equal('20240105');
        });
        it('a computer that writes the year first (ja-JP) can\'t say: Map asks, naming it; Validate stops it', async () => {
            const c = { type: 'date', format: 'auto_date', value: '05/01/2024', locale: 'ja-JP' };
            const r = await run(c);
            say('1a date', c, r);
            expect(r.mapShows, 'not converted').to.equal('05/01/2024');
            expect(r.mapSays).to.match(/^Day or month first\?/);
            expect(r.validateSays).to.match(/^day or month first\?/);
            expect(r.sent).to.equal(undefined);
        });
        it('a column with days over 12 in both places is not one order: asked, whatever the computer says', () => {
            const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
            const w = dom.window as any;
            w.vscode = { postMessage: () => undefined };
            for (const file of SCRIPTS) w.eval(fs.readFileSync(path.join(SHARED, file), 'utf8'));
            w.CSVHandler.setState({ systemDateOrder: { order: 'dmy', locale: 'en-AU' } });
            const auto = w.DTTypeCoercion.resolveAutoDate(['25/01/2024', '01/25/2024', '05/01/2024']);
            expect({ format: auto.format, ambiguous: auto.ambiguous, mixed: auto.mixed }).to.deep.equal({ format: null, ambiguous: true, mixed: true });
        });
    });

    describe('1b. datetimes (behaviour unchanged, waiting on the source-timezone decision)', () => {
        it('with a zone: the same instant from every computer', async () => {
            const c = { type: 'datetime', format: 'passthrough', value: '2024-01-05T10:00:00Z' };
            const r = await run(c);
            say('1b datetime', c, r);
            expect(r.sent).to.equal('2024-01-05T10:00:00');
        });
        it('without a zone: read in the computer\'s own timezone today (the day can move: James\'s decision)', async () => {
            const c = { type: 'datetime', format: 'passthrough', value: '2024-01-05 10:00' };
            const r = await run(c);
            say('1b datetime', c, r);
            // (recorded, not asserted: the source timezone, wired in or removed, is James's call)
            expect(r.sent).to.be.a('string');
        });
    });

    describe('1c. Change time zone on the way to Validate: the file\'s timezone to the environment\'s Target (2026-11-25)', () => {
        // Run under TZ=Australia/Sydney, UTC and America/Los_Angeles. The expected values are worked out here, not by
        // the code under test
        const wall = (instant: Date, zone: string) => {
            const p: Record<string, string> = {};
            new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
                .formatToParts(instant).forEach(x => { p[x.type] = x.value; });
            return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
        };
        // Target UTC, the File's timezone left at this computer's: byte for byte what was sent before, plain and |iso
        for (const value of ['2024-01-05 10:00', '2024-07-05 10:00:00', '2024-01-05T23:30', '2024/01/05 10:00', 'Jan 5 2024 10:00',
            '2024-01-05T10:00:00.123', '2024-01-05', '2024-01-05T10:00:00Z']) {
            for (const modifier of [undefined, 'iso']) {
                it(`Target UTC sends exactly what it did: "${value}"${modifier ? ' |' + modifier : ''}`, async () => {
                    const c = { type: 'datetime', modifier, format: 'passthrough', value };
                    const r = await run(c);
                    say('1c UTC', c, r);
                    expect(r.sent, 'byte-identical to before').to.equal(await sentBefore(value, modifier));
                    if (!modifier) expect(r.mapShows, 'Map shows what Validate holds').to.equal(r.validateHolds);
                });
            }
        }
        for (const value of ['2024-01-05 10:00', '2024-07-05 10:00:00', '2024-01-05T23:30']) {
            it(`Target America/Chicago: "${value}" read in this computer's timezone, sent as Chicago's clock; Validate holds it`, async () => {
                const c = { type: 'datetime', format: 'passthrough', value, target: 'America/Chicago' };
                const r = await run(c);
                say('1c Chicago', c, r);
                expect(r.sent).to.equal(wall(new Date(value.replace(' ', 'T')), 'America/Chicago'));
                expect(r.validateHolds, 'what Validate shows is what is sent').to.equal(r.sent);
                expect(r.mapShows, 'Map shows it too').to.equal(r.sent);
            });
        }
        // The File's timezone differs from the computer's: a file from Chicago (CST is UTC-6 in January, CDT UTC-5 in July)
        for (const [value, utc] of [['2024-01-05 10:00', '2024-01-05T16:00:00'], ['2024-07-05 10:00', '2024-07-05T15:00:00'], ['2024-01-05 23:30', '2024-01-06T05:30:00']]) {
            it(`a file in America/Chicago, Target UTC: "${value}" is sent as ${utc} from any computer`, async () => {
                const c = { type: 'datetime', format: 'passthrough', value, timezone: 'America/Chicago' };
                const r = await run(c);
                say('1c file Chicago → UTC', c, r);
                expect(r.sent).to.equal(utc);
                expect(r.validateHolds).to.equal(utc);
            });
            it(`a file in America/Chicago, Target America/Chicago: "${value}" is sent as written`, async () => {
                const c = { type: 'datetime', format: 'passthrough', value, timezone: 'America/Chicago', target: 'America/Chicago' };
                const r = await run(c);
                say('1c file Chicago → Chicago', c, r);
                expect(r.sent).to.equal(value.replace(' ', 'T') + ':00');
            });
        }
        it('a |iso variable keeps UTC on a Chicago Target: sent exactly as on a UTC one', async () => {
            const c = { type: 'datetime', modifier: 'iso', format: 'passthrough', value: '2024-01-05 10:00' };
            expect((await run({ ...c, target: 'America/Chicago' })).sent).to.equal((await run(c)).sent);
        });
        // A time with its own zone: the moment it says, in the Target's clock, from any computer (the File's timezone
        // doesn't apply to it). Chicago is UTC-6 in January, UTC-5 in July
        for (const [value, utc, chicago] of [
            ['2024-01-05T10:00:00Z', '2024-01-05T10:00:00', '2024-01-05T04:00:00'],
            ['2024-07-05T10:00:00Z', '2024-07-05T10:00:00', '2024-07-05T05:00:00'],
            ['2024-01-05T10:00:00+05:30', '2024-01-05T04:30:00', '2024-01-04T22:30:00'],
            ['2024-01-05T10:00:00-0500', '2024-01-05T15:00:00', '2024-01-05T09:00:00']
        ]) {
            it(`"${value}": sent as ${utc} on a UTC Target and ${chicago} on a Chicago one, from any computer`, async () => {
                for (const [target, expected] of [[undefined, utc], ['America/Chicago', chicago]]) {
                    for (const timezone of [undefined, 'Asia/Tokyo']) {
                        const c = { type: 'datetime', format: 'passthrough', value, target, timezone };
                        const r = await run(c);
                        say('1c own zone', c, r);
                        expect(r.sent, `${target || 'UTC'}, file ${timezone || 'this computer'}`).to.equal(expected);
                        expect(r.validateHolds, 'what Validate shows is what is sent').to.equal(expected);
                    }
                }
            });
        }
        it('a time with its own offset on a UTC Target: changed, it was sent as the computer\'s clock', async () => {
            expect((await run({ type: 'datetime', format: 'passthrough', value: '2024-01-05T10:00:00+05:30' })).sent).to.equal('2024-01-05T04:30:00');
        });
        it('Back to Map and Next again starts from the file: the time is moved once', () => {
            const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
            const w = dom.window as any;
            w.vscode = { postMessage: () => undefined };
            for (const file of SCRIPTS) w.eval(fs.readFileSync(path.join(SHARED, file), 'utf8'));
            const variable = { name: 'v', dataType: 'datetime', mappedTo: 'v', formatModifier: '' };
            const rows = [['2024-01-05 10:00']];
            w.CSVHandler.setState({ templateVariables: [variable], sourceTypes: { v: 'passthrough' }, sourceTimezone: 'America/Chicago',
                currentEnvironment: { targetTimezone: 'UTC' }, currentParsedData: { headers: ['v'], rows } });
            const first = w.DTTypeCoercion.applySourceFormatToRows(['v'], rows, [variable]);
            const second = w.DTTypeCoercion.applySourceFormatToRows(['v'], rows, [variable]);
            expect(rows[0][0], "the file's row is never changed").to.equal('2024-01-05 10:00');
            expect(first[0][0]).to.equal('2024-01-05T16:00:00');
            expect(second[0][0]).to.equal(first[0][0]);
            // ...and Execute's type transform is not asked to read that column again
            expect(w.DTTypeCoercion.filterNonStringTypes({ v: 'datetime', n: 'number' })).to.deep.equal({ n: 'number' });
        });
    });

    describe('2. leading zeros on :number (the default Source format, Standard Number)', () => {
        it('a GTIN "00012345600012": Map shows it, and it is sent, with its zeros', async () => {
            const c = { type: 'number', format: 'standard', value: '00012345600012' };
            const r = await run(c);
            say('2 zeros', c, r);
            expect(r.mapShows).to.equal('00012345600012');
            expect(r.sent).to.equal('00012345600012');
        });
        it('a plain number is still sent as a number', async () => {
            const c = { type: 'number', format: 'standard', value: '1,250' };
            const r = await run(c);
            say('2 zeros', c, r);
            expect(r.sent).to.equal(1250);
        });
    });

    describe('4. boolean: the words Map\'s check accepts are sent', () => {
        for (const [value, expected] of [['active', true], ['enabled', true], ['inactive', false], ['disabled', false], ['true', true], ['No', false]] as Array<[string, boolean]>) {
            it(`"${value}" is sent as ${expected}`, async () => {
                const c = { type: 'boolean', format: 'boolean', value };
                const r = await run(c);
                say('4 boolean', c, r);
                expect(r.sent, r.fails || `Map shows ${r.mapShows}`).to.equal(expected);
            });
        }
    });

    describe('5. :number|int: Map shows 2.7 as it is and says it isn\'t whole; Validate stops it', () => {
        it('2.7', async () => {
            const c = { type: 'number', modifier: 'int', format: 'standard', value: '2.7' };
            const r = await run(c);
            say('5 int', c, r);
            expect(r.mapShows).to.equal('2.7');
            expect(r.mapSays).to.equal('Not a whole number');
            expect(r.validateSays).to.match(/must be an integer/);
            expect(r.sent).to.equal(undefined);
        });
    });

    describe('6. Excel Serial: converted once', () => {
        it('45296 is sent as 2024-01-05, not converted a second time at Execute', async () => {
            const c = { type: 'date', format: 'excel_serial', value: '45296' };
            const r = await run(c);
            say('6 serial', c, r);
            expect(dayOf(r.sent), r.fails || `Validate holds ${r.validateHolds}, sent ${JSON.stringify(r.sent)}`).to.equal('20240105');
        });
    });
});
