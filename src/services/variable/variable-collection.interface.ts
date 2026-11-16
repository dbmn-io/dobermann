// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
export interface VariableCollectionResult {
  variables: Record<string, string>;
  cancelled: boolean;
  errorMessage?: string;
}

export interface VariableParseResult {
  variables: Record<string, string>;
  isValid: boolean;
  errorMessage?: string;
}

export interface IVariableCollectionService {
  collectVariables(
    requiredVariables: string[],
    templateBody: string
  ): Promise<VariableCollectionResult>;
  
  parseVariableInput(
    input: string,
    requiredVariables: string[]
  ): Promise<VariableParseResult>;
  
  validateVariables(
    variables: Record<string, string>,
    requiredVariables: string[]
  ): Promise<boolean>;
  
  extractVariablesFromTemplate(
    template: string
  ): string[];
}