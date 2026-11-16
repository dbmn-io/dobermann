// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { 
  IVariableCollectionService, 
  VariableCollectionResult, 
  VariableParseResult 
} from './variable-collection.interface';

// Abstract VS Code window interface
interface IVSCodeWindow {
  showInputBox(options?: { 
    placeHolder?: string; 
    prompt?: string; 
    ignoreFocusOut?: boolean; 
    validateInput?: (value: string) => string | undefined;
  }): Promise<string | undefined>;
}

export class VariableCollectionService implements IVariableCollectionService {
  constructor(private vsCodeWindow: IVSCodeWindow) {}

  async collectVariables(
    requiredVariables: string[], 
    templateBody: string
  ): Promise<VariableCollectionResult> {
    // If no required variables, return empty result
    if (requiredVariables.length === 0) {
      return {
        variables: {},
        cancelled: false,
        errorMessage: undefined
      };
    }

    // Show InputBox for variable collection
    const input = await this.vsCodeWindow.showInputBox({
      placeHolder: 'Enter variables (e.g., name=John, age=25)',
      prompt: `Required variables: ${requiredVariables.join(', ')}`,
      ignoreFocusOut: true,
      validateInput: (value: string) => {
        if (!value || value.trim() === '') {
          return 'Variable input cannot be empty';
        }
        
        // Basic format validation
        if (!value.includes('=')) {
          return 'Invalid variable format. Use: variable1=value1, variable2=value2';
        }
        
        return undefined;
      }
    });

    // Handle cancellation
    if (input === undefined) {
      return {
        variables: {},
        cancelled: true,
        errorMessage: undefined
      };
    }

    // Parse the input
    const parseResult = await this.parseVariableInput(input, requiredVariables);
    
    if (!parseResult.isValid) {
      return {
        variables: {},
        cancelled: false,
        errorMessage: parseResult.errorMessage
      };
    }

    return {
      variables: parseResult.variables,
      cancelled: false,
      errorMessage: undefined
    };
  }

  async parseVariableInput(
    input: string, 
    requiredVariables: string[]
  ): Promise<VariableParseResult> {
    if (!input || input.trim() === '') {
      return {
        variables: {},
        isValid: false,
        errorMessage: 'Variable input cannot be empty'
      };
    }

    try {
      const variables: Record<string, string> = {};
      
      // Split by commas and process each variable
      const pairs = input.split(',').map(pair => pair.trim());
      
      for (const pair of pairs) {
        if (!pair.includes('=')) {
          return {
            variables: {},
            isValid: false,
            errorMessage: 'Invalid variable format. Use: variable1=value1, variable2=value2'
          };
        }

        const [key, ...valueParts] = pair.split('=');
        const trimmedKey = key.trim();
        let value = valueParts.join('=').trim();

        // Handle quoted values
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        variables[trimmedKey] = value;
      }

      // Check if all required variables are present
      const missingVariables = requiredVariables.filter(
        varName => !variables.hasOwnProperty(varName) || variables[varName] === ''
      );

      if (missingVariables.length > 0) {
        return {
          variables: {},
          isValid: false,
          errorMessage: `Missing required variables: ${missingVariables.join(', ')}`
        };
      }

      return {
        variables,
        isValid: true,
        errorMessage: undefined
      };
    } catch (error) {
      return {
        variables: {},
        isValid: false,
        errorMessage: 'Invalid variable format. Use: variable1=value1, variable2=value2'
      };
    }
  }

  async validateVariables(
    variables: Record<string, string>, 
    requiredVariables: string[]
  ): Promise<boolean> {
    // Check if all required variables are present and have non-empty values
    for (const varName of requiredVariables) {
      if (!variables.hasOwnProperty(varName) || 
          variables[varName] === '' || 
          variables[varName] === null || 
          variables[varName] === undefined) {
        return false;
      }
    }

    return true;
  }

  extractVariablesFromTemplate(template: string): string[] {
    if (!template || template.trim() === '') {
      return [];
    }

    const variablePattern = /\{\{([^}:]+)(?::[^}]+)?\}\}/g;
    const variables: string[] = [];
    let match;

    while ((match = variablePattern.exec(template)) !== null) {
      const variableName = match[1].trim();
      if (!variables.includes(variableName)) {
        variables.push(variableName);
      }
    }

    return variables;
  }
}