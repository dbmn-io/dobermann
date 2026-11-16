# Test Fixtures - File Formats

This directory contains test files for various data formats used in testing the Format Converter Service and Data Type Detection Service.

## File Descriptions

### Core Format Types

- **`standard-csv.csv`** - Standard comma-separated values file with proper quoting
- **`tab-separated.tsv`** - Tab-delimited file format
- **`semicolon-delimited.csv`** - European-style CSV with semicolon delimiters
- **`cobol-sample.txt`** - COBOL fixed-format file with pipe delimiters and padded numbers

### Data Type Testing

- **`mixed-data-types.csv`** - Contains strings, numbers, booleans, and dates for type detection testing
- **`datetime-formats.csv`** - Various date and time formats including ISO 8601 and timezones
- **`scientific-notation.csv`** - Scientific notation numbers (e.g., 1.23e+4)
- **`currency-formats.csv`** - Currency values with symbols and percentage formats

### Edge Cases

- **`edge-cases.csv`** - Empty values, special characters, multi-line content, and invalid data
- **`sample-excel.csv`** - Excel-compatible format for conversion testing

## Usage in Tests

These fixtures are designed to test:

1. **Format Detection** - Automatic detection of delimiter types and file formats
2. **Data Type Detection** - Identification of column data types (string, number, date, boolean, etc.)
3. **Data Transformation** - Conversion between formats (COBOL → standard numbers)
4. **Dual-Stage Validation** - Source consistency and mapping compatibility validation
5. **Edge Case Handling** - Proper handling of malformed or unusual data

## COBOL Format Notes

The `cobol-sample.txt` file contains:
- **Pipe-delimited** columns (`|`)
- **Padded numbers** with signs (e.g., `+000018210.0000`, `-000005000.0000`)
- **Boolean indicators** (`Y`/`N`)
- **Fixed-width date format** (`YYYY-MM-DD`)

These should be detected as:
- `name`: string
- `amount`: number (converted from `+000018210.0000` to `18210`)
- `balance`: number (converted from `-000005000.0000` to `-5000`)  
- `active`: boolean (Y/N converted to true/false)
- `date`: date

## Integration with Services

These fixtures integrate with:
- `FormatConverterService` - Format detection and conversion
- `DataTypeDetectionService` - Column type analysis  
- `DataTransformationService` - Value transformations
- `CSVValidationService` - Dual-stage validation testing