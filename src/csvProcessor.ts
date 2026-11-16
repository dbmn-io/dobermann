// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as fs from 'fs';
import * as csv from 'csv-parser';
// Removed axios dependency - using native fetch
import * as vscode from 'vscode';

export interface CSVRow {
    [key: string]: string;
}

export class CSVProcessor {
    private readonly API_BASE_URL = 'https://your-api-endpoint.com/api';

    async processCSV(filePath: string, accessToken: string): Promise<void> {
        const rows: CSVRow[] = [];
        
        return new Promise((resolve, reject) => {
            fs.createReadStream(filePath)
                .pipe(csv())
                .on('data', (row: CSVRow) => {
                    rows.push(row);
                })
                .on('end', async () => {
                    try {
                        await this.makeAPICalls(rows, accessToken);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                })
                .on('error', (error) => {
                    reject(error);
                });
        });
    }

    private async makeAPICalls(rows: CSVRow[], accessToken: string): Promise<void> {
        const progress = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Processing CSV data',
            cancellable: false
        }, async (progress) => {
            const total = rows.length;
            let completed = 0;

            for (const row of rows) {
                try {
                    await this.makeAPICall(row, accessToken);
                    completed++;
                    
                    progress.report({
                        increment: (100 / total),
                        message: `Processed ${completed}/${total} rows`
                    });
                    
                    await new Promise(resolve => setTimeout(resolve, 100));
                } catch (error) {
                    console.error('API call failed for row:', row, error);
                }
            }
        });
    }

    private async makeAPICall(row: CSVRow, accessToken: string): Promise<any> {
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        };

        const response = await fetch(`${this.API_BASE_URL}/data`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(row)
        });

        if (!response.ok) {
            throw new Error(`API call failed: ${response.status} ${response.statusText}`);
        }

        return await response.json();
    }
}