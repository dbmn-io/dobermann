// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #230: "Create Template": an Excel workbook whose columns are an endpoint's
 * template variables, typed, with one sample row. Built in memory; the host saves the bytes.
 */
import * as XLSX from 'xlsx';
import type { APIEndpointConfig } from '../../apiConfigManager';

type ColumnType = 'string' | 'number' | 'boolean' | 'date';

export interface TemplateVariable {
    name: string;
    dataType: string;
    /** Date/datetime format (e.g. iso, MM/dd/yyyy). */
    formatModifier?: string;
    columnType: ColumnType;
}

/** `{{name:type:format|modifiers}}` in one string, minus what isn't user input. */
function variablesIn(template: string): Array<Omit<TemplateVariable, 'columnType'>> {
    const variables: Array<Omit<TemplateVariable, 'columnType'>> = [];
    for (const match of template.matchAll(/\{\{([^}]+)\}\}/g)) {
        const text = match[1].trim();
        // Issue #284: ENV: comes from the environment, V8:/A8: are generated at run time
        if (text.startsWith('A8:') || text.startsWith('A8.') || text.startsWith('V8:') || text.toUpperCase().startsWith('ENV:')) {
            continue;
        }
        const pipe = text.indexOf('|');
        const parts = (pipe >= 0 ? text.substring(0, pipe) : text).split(':');
        const name = parts[0].trim();
        if (!variables.some(v => v.name === name)) {
            variables.push({ name, dataType: parts[1]?.trim() || 'string', formatModifier: parts[2]?.trim() || undefined });
        }
    }
    return variables;
}

function columnType(dataType: string): ColumnType {
    switch (dataType.toLowerCase()) {
        case 'number': case 'integer': case 'float': case 'decimal': return 'number';
        case 'boolean': case 'bool': return 'boolean';
        case 'date': case 'datetime': case 'timestamp': return 'date';
        default: return 'string';
    }
}

/** Every variable in the body, path, query parameters and headers, once each. */
export function endpointTemplateVariables(endpoint: Partial<APIEndpointConfig>): TemplateVariable[] {
    const found = new Map<string, Omit<TemplateVariable, 'columnType'>>();
    const add = (template: unknown) => {
        if (typeof template !== 'string') return;
        for (const v of variablesIn(template)) {
            const existing = found.get(v.name);
            if (!existing) {
                found.set(v.name, v);
                continue;
            }
            if (!existing.dataType || existing.dataType === 'string') existing.dataType = v.dataType;
            if (!existing.formatModifier && v.formatModifier) existing.formatModifier = v.formatModifier;
        }
    };
    const valueOf = (value: unknown) => typeof value === 'string' ? value : (value as { value?: unknown } | null)?.value;
    add(endpoint.body);
    add(endpoint.path);
    Object.values(endpoint.queryParams ?? {}).forEach(value => add(valueOf(value)));
    Object.values(endpoint.headers ?? {}).forEach(value => add(valueOf(value)));
    return [...found.values()].map(v => ({ ...v, columnType: columnType(v.dataType) }));
}

const EXCEL_DATE_FORMATS: Record<string, [excel: string, sample: string]> = {
    'MM/dd/yyyy': ['mm/dd/yyyy', '01/15/2026'],
    'dd/MM/yyyy': ['dd/mm/yyyy', '15/01/2026'],
    'yyyy-MM-dd': ['yyyy-mm-dd', '2026-01-15'],
    'MM-dd-yyyy': ['mm-dd-yyyy', '01-15-2026'],
    'dd-MM-yyyy': ['dd-mm-yyyy', '15-01-2026'],
    'yyyyMMdd': ['yyyymmdd', '20260115'],
    'yyyy/MM/dd': ['yyyy/mm/dd', '2026/01/15'],
    'dd.MM.yyyy': ['dd.mm.yyyy', '15.01.2026'],
    'MMM dd, yyyy': ['mmm dd, yyyy', 'Jan 15, 2026'],
    'yyyy-MM-dd HH:mm:ss': ['yyyy-mm-dd hh:mm:ss', '2026-01-15 10:30:00'],
    'MM/dd/yyyy HH:mm:ss': ['mm/dd/yyyy hh:mm:ss', '01/15/2026 10:30:00'],
    'yyyy-MM-ddTHH:mm:ss': ['yyyy-mm-dd"T"hh:mm:ss', '2026-01-15T10:30:00']
};
const ISO_DATE: [string, string] = ['yyyy-mm-dd', '2026-01-15'];

function excelFormat(v: TemplateVariable): string {
    switch (v.columnType) {
        case 'number': return '#,##0.00';
        case 'date': return (v.formatModifier && EXCEL_DATE_FORMATS[v.formatModifier] || ISO_DATE)[0];
        default: return '@'; // text: stops Excel converting strings and TRUE/FALSE
    }
}

function sampleValue(v: TemplateVariable): string | number {
    switch (v.columnType) {
        case 'number': return 123;
        case 'boolean': return 'TRUE';
        case 'date': return (v.formatModifier && EXCEL_DATE_FORMATS[v.formatModifier] || ISO_DATE)[1];
        default: return 'sample';
    }
}

/** The workbook: header + one typed sample row in an Excel Table (#256: no reserved empty rows). */
export function buildTemplateWorkbook(variables: TemplateVariable[]): Uint8Array {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([variables.map(v => v.name), variables.map(sampleValue)]);
    const thin = { style: 'thin', color: { rgb: '000000' } };
    variables.forEach((v, c) => {
        const header = sheet[XLSX.utils.encode_cell({ r: 0, c })];
        if (header) {
            header.s = {
                font: { bold: true, color: { rgb: 'FFFFFF' } },
                fill: { fgColor: { rgb: '4472C4' } },
                alignment: { horizontal: 'center', vertical: 'center' },
                border: { top: thin, bottom: thin, left: thin, right: thin }
            };
        }
        const sample = sheet[XLSX.utils.encode_cell({ r: 1, c })];
        if (sample) {
            const format = excelFormat(v);
            sample.s = { ...(sample.s || {}), numFmt: format };
            sample.z = format;
        }
    });
    sheet['!cols'] = variables.map(v => ({ wch: Math.max(v.name.length + 2, 15) }));
    const range = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 1, c: variables.length - 1 } });
    sheet['!ref'] = range;
    (sheet as Record<string, unknown>)['!tables'] = [{
        ref: range,
        name: 'TemplateData',
        displayName: 'Template Data',
        headerRowCount: 1,
        totalsRowCount: 0,
        columns: variables.map((v, i) => ({ id: i + 1, name: v.name, totalsRowFunction: 'none' })),
        autoFilter: { ref: range },
        tableStyleInfo: { name: 'TableStyleMedium2', showFirstColumn: false, showLastColumn: false, showRowStripes: true, showColumnStripes: false }
    }];
    sheet['!autofilter'] = { ref: range };
    XLSX.utils.book_append_sheet(workbook, sheet, 'Template');
    return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer);
}
