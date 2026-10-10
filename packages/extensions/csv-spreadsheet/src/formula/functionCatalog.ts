/**
 * Signatures and one-line descriptions for every function the formula engine
 * accepts, for autocomplete and signature help.
 *
 * The table must stay in step with the engine's allow-list
 * (`getSupportedFunctions()` in `../utils/formulaEngine`); a test fails when a
 * function is added to one side only. Signatures describe what the engine
 * actually does, which is formula.js and not always Excel: `COLUMN` and `ROW`
 * pick one column or row out of an array rather than reporting a position.
 *
 * Signature notation: parameters separated by `, `. `[name]` is optional.
 * `name...` repeats. Consecutive trailing repeating parameters form a group
 * that repeats together (`IFS`, `SUMIFS`).
 */

export type FunctionCategory =
  | 'logical'
  | 'lookup'
  | 'information'
  | 'math'
  | 'statistical'
  | 'text'
  | 'date'
  | 'financial'
  | 'engineering'
  /** Not a function: a named range offered by autocomplete (`formulaAssist.ts`). */
  | 'named range';

export interface FunctionParam {
  name: string;
  optional: boolean;
  repeating: boolean;
}

export interface FunctionCatalogEntry {
  name: string;
  category: FunctionCategory;
  params: FunctionParam[];
  /** The signature as written in the table, e.g. `number1, [number2...]`. */
  signature: string;
  description: string;
}

type Row = [name: string, category: FunctionCategory, signature: string, description: string];

const L: FunctionCategory = 'logical';
const K: FunctionCategory = 'lookup';
const I: FunctionCategory = 'information';
const M: FunctionCategory = 'math';
const S: FunctionCategory = 'statistical';
const T: FunctionCategory = 'text';
const D: FunctionCategory = 'date';
const F: FunctionCategory = 'financial';
const E: FunctionCategory = 'engineering';

const NUMBERS = 'number1, [number2...]';
const VALUES = 'value1, [value2...]';
const CRITERIA_PAIRS = 'criteria_range1, criterion1, [criteria_range2...], [criterion2...]';

const ROWS: Row[] = [
  // Logical.
  ['AND', L, 'logical1, [logical2...]', 'TRUE when every argument is true.'],
  ['FALSE', L, '', 'The logical value FALSE.'],
  ['IF', L, 'logical_test, value_if_true, [value_if_false]', 'Returns one value when a condition is true and another when it is false.'],
  ['IFERROR', L, 'value, value_if_error', 'Returns value, or value_if_error when value is any error.'],
  ['IFNA', L, 'value, value_if_na', 'Returns value, or value_if_na when value is #N/A.'],
  ['IFS', L, 'logical_test1, value_if_true1, [logical_test2...], [value_if_true2...]', 'Returns the value for the first condition that is true.'],
  ['NOT', L, 'logical', 'Reverses a logical value.'],
  ['OR', L, 'logical1, [logical2...]', 'TRUE when any argument is true.'],
  ['SWITCH', L, 'expression, value1, result1, [value2...], [result2...]', 'Returns the result paired with the first value that matches expression; a trailing lone argument is the default.'],
  ['TRUE', L, '', 'The logical value TRUE.'],
  ['XOR', L, 'logical1, [logical2...]', 'TRUE when an odd number of arguments are true.'],

  // Lookup and reference.
  ['CHOOSE', K, 'index_num, value1, [value2...]', 'Returns the value at a 1-based position in the list.'],
  ['COLUMN', K, 'array, column_index', 'Returns one column of an array by zero-based index.'],
  ['COLUMNS', K, 'array', 'Number of columns in a range or array.'],
  ['HLOOKUP', K, 'lookup_value, table_array, row_index_num, [range_lookup]', 'Finds a value in the top row of a table and returns the value in the given row.'],
  ['HYPERLINK', K, 'url, [link_label]', 'A clickable link to url, shown as link_label.'],
  ['INDEX', K, 'array, row_num, [column_num]', 'Returns the value at a row and column of a range.'],
  ['LOOKUP', K, 'lookup_value, lookup_vector, [result_vector]', 'Finds a value in one row or column and returns the matching value from another.'],
  ['MATCH', K, 'lookup_value, lookup_array, [match_type]', 'Position of a value in a range (match_type 0 for exact, 1 or -1 for nearest).'],
  ['ROW', K, 'array, row_index', 'Returns one row of an array by zero-based index.'],
  ['ROWS', K, 'array', 'Number of rows in a range or array.'],
  ['VLOOKUP', K, 'lookup_value, table_array, col_index_num, [range_lookup]', 'Finds a value in the first column of a table and returns the value in the given column.'],

  // Information.
  ['ISBLANK', I, 'value', 'TRUE when the value is empty.'],
  ['ISERR', I, 'value', 'TRUE when the value is any error except #N/A.'],
  ['ISERROR', I, 'value', 'TRUE when the value is any error.'],
  ['ISEVEN', I, 'number', 'TRUE when the number is even.'],
  ['ISLOGICAL', I, 'value', 'TRUE when the value is TRUE or FALSE.'],
  ['ISNA', I, 'value', 'TRUE when the value is #N/A.'],
  ['ISNONTEXT', I, 'value', 'TRUE when the value is not text.'],
  ['ISNUMBER', I, 'value', 'TRUE when the value is a number.'],
  ['ISODD', I, 'number', 'TRUE when the number is odd.'],
  ['ISTEXT', I, 'value', 'TRUE when the value is text.'],
  ['N', I, 'value', 'Converts a value to a number.'],
  ['NA', I, '', 'Returns the #N/A error.'],
  ['TYPE', I, 'value', 'Type code of a value: 1 number, 2 text, 4 logical, 16 error, 64 array.'],

  // Math and trigonometry.
  ['ABS', M, 'number', 'Absolute value of a number.'],
  ['ACOS', M, 'number', 'Arccosine, in radians.'],
  ['ACOSH', M, 'number', 'Inverse hyperbolic cosine.'],
  ['ACOT', M, 'number', 'Arccotangent, in radians.'],
  ['ACOTH', M, 'number', 'Inverse hyperbolic cotangent.'],
  ['ARABIC', M, 'text', 'Converts a Roman numeral to a number.'],
  ['ASIN', M, 'number', 'Arcsine, in radians.'],
  ['ASINH', M, 'number', 'Inverse hyperbolic sine.'],
  ['ATAN', M, 'number', 'Arctangent, in radians.'],
  ['ATAN2', M, 'x_num, y_num', 'Angle of the point (x, y) from the x-axis, in radians.'],
  ['ATANH', M, 'number', 'Inverse hyperbolic tangent.'],
  ['BASE', M, 'number, radix, [min_length]', 'Converts a number to text in the given base.'],
  ['CEILING', M, 'number, significance', 'Rounds up to the nearest multiple of significance.'],
  ['CEILINGMATH', M, 'number, [significance], [mode]', 'Rounds up to the nearest integer or multiple of significance.'],
  ['CEILINGPRECISE', M, 'number, [significance]', 'Rounds up to the nearest multiple of significance, whatever the sign.'],
  ['COMBIN', M, 'number, number_chosen', 'Number of combinations without repetition.'],
  ['COMBINA', M, 'number, number_chosen', 'Number of combinations with repetition.'],
  ['COS', M, 'number', 'Cosine of an angle in radians.'],
  ['COSH', M, 'number', 'Hyperbolic cosine.'],
  ['COT', M, 'number', 'Cotangent of an angle in radians.'],
  ['COTH', M, 'number', 'Hyperbolic cotangent.'],
  ['CSC', M, 'number', 'Cosecant of an angle in radians.'],
  ['CSCH', M, 'number', 'Hyperbolic cosecant.'],
  ['DECIMAL', M, 'text, radix', 'Converts text in the given base to a decimal number.'],
  ['DEGREES', M, 'angle', 'Converts radians to degrees.'],
  ['EVEN', M, 'number', 'Rounds away from zero to the nearest even integer.'],
  ['EXP', M, 'number', 'e raised to the given power.'],
  ['FACT', M, 'number', 'Factorial of a number.'],
  ['FACTDOUBLE', M, 'number', 'Double factorial of a number.'],
  ['FLOOR', M, 'number, significance', 'Rounds down to the nearest multiple of significance.'],
  ['FLOORMATH', M, 'number, [significance], [mode]', 'Rounds down to the nearest integer or multiple of significance.'],
  ['FLOORPRECISE', M, 'number, [significance]', 'Rounds down to the nearest multiple of significance, whatever the sign.'],
  ['GCD', M, NUMBERS, 'Greatest common divisor.'],
  ['INT', M, 'number', 'Rounds down to the nearest integer.'],
  ['LCM', M, NUMBERS, 'Least common multiple.'],
  ['LN', M, 'number', 'Natural logarithm.'],
  ['LOG', M, 'number, [base]', 'Logarithm in the given base (10 by default).'],
  ['LOG10', M, 'number', 'Base-10 logarithm.'],
  ['MOD', M, 'number, divisor', 'Remainder after division.'],
  ['MROUND', M, 'number, multiple', 'Rounds to the nearest multiple.'],
  ['MULTINOMIAL', M, NUMBERS, 'Multinomial coefficient of a set of numbers.'],
  ['ODD', M, 'number', 'Rounds away from zero to the nearest odd integer.'],
  ['PI', M, '', 'The value of pi.'],
  ['POWER', M, 'number, power', 'A number raised to a power.'],
  ['PRODUCT', M, NUMBERS, 'Multiplies its arguments.'],
  ['QUOTIENT', M, 'numerator, denominator', 'Integer part of a division.'],
  ['RADIANS', M, 'angle', 'Converts degrees to radians.'],
  ['RAND', M, '', 'Random number from 0 up to 1.'],
  ['RANDBETWEEN', M, 'bottom, top', 'Random integer between two numbers.'],
  ['ROMAN', M, 'number', 'Converts a number to Roman numerals.'],
  ['ROUND', M, 'number, num_digits', 'Rounds to a number of digits.'],
  ['ROUNDDOWN', M, 'number, num_digits', 'Rounds toward zero to a number of digits.'],
  ['ROUNDUP', M, 'number, num_digits', 'Rounds away from zero to a number of digits.'],
  ['SEC', M, 'number', 'Secant of an angle in radians.'],
  ['SECH', M, 'number', 'Hyperbolic secant.'],
  ['SIGN', M, 'number', '1, 0 or -1 for the sign of a number.'],
  ['SIN', M, 'number', 'Sine of an angle in radians.'],
  ['SINH', M, 'number', 'Hyperbolic sine.'],
  ['SQRT', M, 'number', 'Square root.'],
  ['SQRTPI', M, 'number', 'Square root of number times pi.'],
  ['SUBTOTAL', M, 'function_num, ref1', 'Aggregates a range by function number (1 AVERAGE, 2 COUNT, 4 MAX, 5 MIN, 9 SUM).'],
  ['SUM', M, NUMBERS, 'Adds its arguments.'],
  ['SUMIF', M, 'range, criterion, [sum_range]', 'Adds the cells that meet a condition.'],
  ['SUMIFS', M, `sum_range, ${CRITERIA_PAIRS}`, 'Adds the cells that meet every condition.'],
  ['SUMPRODUCT', M, 'array1, [array2...]', 'Sum of the products of matching array entries.'],
  ['SUMSQ', M, NUMBERS, 'Sum of the squares of its arguments.'],
  ['SUMX2MY2', M, 'array_x, array_y', 'Sum of the differences of squares of two arrays.'],
  ['SUMX2PY2', M, 'array_x, array_y', 'Sum of the sums of squares of two arrays.'],
  ['SUMXMY2', M, 'array_x, array_y', 'Sum of the squared differences of two arrays.'],
  ['TAN', M, 'number', 'Tangent of an angle in radians.'],
  ['TANH', M, 'number', 'Hyperbolic tangent.'],
  ['TRUNC', M, 'number, [num_digits]', 'Truncates a number to a number of digits.'],

  // Statistical.
  ['AVEDEV', S, NUMBERS, 'Average absolute deviation from the mean.'],
  ['AVERAGE', S, NUMBERS, 'Arithmetic mean of its arguments.'],
  ['AVERAGEA', S, VALUES, 'Mean counting text as 0 and TRUE as 1.'],
  ['AVERAGEIF', S, 'range, criterion, [average_range]', 'Mean of the cells that meet a condition.'],
  ['AVERAGEIFS', S, `average_range, ${CRITERIA_PAIRS}`, 'Mean of the cells that meet every condition.'],
  ['CORREL', S, 'array1, array2', 'Correlation coefficient of two data sets.'],
  ['COUNT', S, VALUES, 'Counts the numbers in its arguments.'],
  ['COUNTA', S, VALUES, 'Counts the non-empty values in its arguments.'],
  ['COUNTBLANK', S, 'range', 'Counts the empty cells in a range.'],
  ['COUNTIF', S, 'range, criterion', 'Counts the cells that meet a condition.'],
  ['COUNTIFS', S, CRITERIA_PAIRS, 'Counts the rows that meet every condition.'],
  ['COVARIANCE.P', S, 'array1, array2', 'Population covariance of two data sets.'],
  ['COVARIANCE.S', S, 'array1, array2', 'Sample covariance of two data sets.'],
  ['DEVSQ', S, NUMBERS, 'Sum of squared deviations from the mean.'],
  ['FREQUENCY', S, 'data_array, bins_array', 'How many values fall into each bin.'],
  ['GEOMEAN', S, NUMBERS, 'Geometric mean.'],
  ['HARMEAN', S, NUMBERS, 'Harmonic mean.'],
  ['INTERCEPT', S, 'known_ys, known_xs', 'Y-intercept of the linear regression line.'],
  ['KURT', S, NUMBERS, 'Kurtosis of a data set.'],
  ['LARGE', S, 'array, k', 'The k-th largest value.'],
  ['MAX', S, NUMBERS, 'Largest value.'],
  ['MAXA', S, VALUES, 'Largest value, counting text as 0 and TRUE as 1.'],
  ['MAXIFS', S, `max_range, ${CRITERIA_PAIRS}`, 'Largest value among the cells that meet every condition.'],
  ['MEDIAN', S, NUMBERS, 'Middle value.'],
  ['MIN', S, NUMBERS, 'Smallest value.'],
  ['MINA', S, VALUES, 'Smallest value, counting text as 0 and TRUE as 1.'],
  ['MINIFS', S, `min_range, ${CRITERIA_PAIRS}`, 'Smallest value among the cells that meet every condition.'],
  ['MODE.MULT', S, NUMBERS, 'All of the most frequent values.'],
  ['MODE.SNGL', S, NUMBERS, 'Most frequent value.'],
  ['PEARSON', S, 'array1, array2', 'Pearson correlation coefficient.'],
  ['PERCENTILE.EXC', S, 'array, k', 'The k-th percentile, k exclusive of 0 and 1.'],
  ['PERCENTILE.INC', S, 'array, k', 'The k-th percentile, k from 0 to 1 inclusive.'],
  ['PERCENTRANK.EXC', S, 'array, x, [significance]', 'Rank of x as a percentage, exclusive of 0 and 1.'],
  ['PERCENTRANK.INC', S, 'array, x, [significance]', 'Rank of x as a percentage from 0 to 1 inclusive.'],
  ['PERMUT', S, 'number, number_chosen', 'Number of permutations without repetition.'],
  ['PERMUTATIONA', S, 'number, number_chosen', 'Number of permutations with repetition.'],
  ['QUARTILE.EXC', S, 'array, quart', 'Quartile of a data set, exclusive method.'],
  ['QUARTILE.INC', S, 'array, quart', 'Quartile of a data set, inclusive method.'],
  ['RANK.AVG', S, 'number, ref, [order]', 'Rank of a number in a list; ties get their average rank.'],
  ['RANK.EQ', S, 'number, ref, [order]', 'Rank of a number in a list; ties share the top rank.'],
  ['RSQ', S, 'known_ys, known_xs', 'Square of the Pearson correlation coefficient.'],
  ['SKEW', S, NUMBERS, 'Sample skewness.'],
  ['SKEWP', S, NUMBERS, 'Population skewness.'],
  ['SLOPE', S, 'known_ys, known_xs', 'Slope of the linear regression line.'],
  ['SMALL', S, 'array, k', 'The k-th smallest value.'],
  ['STANDARDIZE', S, 'x, mean, standard_dev', 'Normalized value (z-score).'],
  ['STDEV', S, NUMBERS, 'Sample standard deviation (same as STDEV.S).'],
  ['STDEV.P', S, NUMBERS, 'Population standard deviation.'],
  ['STDEV.S', S, NUMBERS, 'Sample standard deviation.'],
  ['STDEVA', S, VALUES, 'Sample standard deviation, counting text as 0 and TRUE as 1.'],
  ['STDEVPA', S, VALUES, 'Population standard deviation, counting text as 0 and TRUE as 1.'],
  ['STEYX', S, 'known_ys, known_xs', 'Standard error of the predicted y for each x.'],
  ['TRIMMEAN', S, 'array, percent', 'Mean after trimming a percentage of extreme values.'],
  ['VAR', S, NUMBERS, 'Sample variance (same as VAR.S).'],
  ['VAR.P', S, NUMBERS, 'Population variance.'],
  ['VAR.S', S, NUMBERS, 'Sample variance.'],
  ['VARA', S, VALUES, 'Sample variance, counting text as 0 and TRUE as 1.'],
  ['VARPA', S, VALUES, 'Population variance, counting text as 0 and TRUE as 1.'],

  // Text.
  ['CHAR', T, 'number', 'Character for a character code.'],
  ['CLEAN', T, 'text', 'Removes nonprintable characters.'],
  ['CODE', T, 'text', 'Character code of the first character.'],
  ['CONCAT', T, 'text1, [text2...]', 'Joins text values.'],
  ['CONCATENATE', T, 'text1, [text2...]', 'Joins text values.'],
  ['DOLLAR', T, 'number, [decimals]', 'Formats a number as currency text.'],
  ['EXACT', T, 'text1, text2', 'TRUE when two texts are identical, case included.'],
  ['FIND', T, 'find_text, within_text, [start_num]', 'Position of one text inside another, case-sensitive.'],
  ['FIXED', T, 'number, [decimals], [no_commas]', 'Formats a number as text with fixed decimals.'],
  ['LEFT', T, 'text, [num_chars]', 'First characters of a text.'],
  ['LEN', T, 'text', 'Number of characters in a text.'],
  ['LOWER', T, 'text', 'Converts text to lowercase.'],
  ['MID', T, 'text, start_num, num_chars', 'Characters from the middle of a text.'],
  ['NUMBERVALUE', T, 'text, [decimal_separator], [group_separator]', 'Converts text to a number using the given separators.'],
  ['PROPER', T, 'text', 'Capitalizes the first letter of each word.'],
  ['REPLACE', T, 'old_text, start_num, num_chars, new_text', 'Replaces characters at a position in a text.'],
  ['REPT', T, 'text, number_times', 'Repeats text a number of times.'],
  ['RIGHT', T, 'text, [num_chars]', 'Last characters of a text.'],
  ['SEARCH', T, 'find_text, within_text, [start_num]', 'Position of one text inside another, case-insensitive with wildcards.'],
  ['SUBSTITUTE', T, 'text, old_text, new_text, [instance_num]', 'Replaces occurrences of old_text with new_text.'],
  ['T', T, 'value', 'The value if it is text, otherwise empty text.'],
  ['TEXT', T, 'value, format_text', 'Formats a value as text with a number format.'],
  ['TEXTJOIN', T, 'delimiter, ignore_empty, text1, [text2...]', 'Joins text values with a delimiter.'],
  ['TRIM', T, 'text', 'Removes extra spaces.'],
  ['UNICHAR', T, 'number', 'Unicode character for a code point.'],
  ['UNICODE', T, 'text', 'Code point of the first character.'],
  ['UPPER', T, 'text', 'Converts text to uppercase.'],
  ['VALUE', T, 'text', 'Converts text to a number.'],

  // Date and time.
  ['DATE', D, 'year, month, day', 'A date from year, month and day.'],
  ['DATEDIF', D, 'start_date, end_date, unit', 'Difference between two dates in days, months or years ("D", "M", "Y").'],
  ['DATEVALUE', D, 'date_text', 'Converts date text to a date.'],
  ['DAY', D, 'serial_number', 'Day of the month, 1 to 31.'],
  ['DAYS', D, 'end_date, start_date', 'Number of days between two dates.'],
  ['DAYS360', D, 'start_date, end_date, [method]', 'Days between two dates on a 360-day year.'],
  ['EDATE', D, 'start_date, months', 'The date a number of months before or after a date.'],
  ['EOMONTH', D, 'start_date, months', 'Last day of the month a number of months away.'],
  ['HOUR', D, 'serial_number', 'Hour, 0 to 23.'],
  ['ISOWEEKNUM', D, 'date', 'ISO week number of the year.'],
  ['MINUTE', D, 'serial_number', 'Minute, 0 to 59.'],
  ['MONTH', D, 'serial_number', 'Month, 1 to 12.'],
  ['NETWORKDAYS', D, 'start_date, end_date, [holidays]', 'Working days between two dates.'],
  ['NETWORKDAYSINTL', D, 'start_date, end_date, [weekend], [holidays]', 'Working days between two dates with a custom weekend.'],
  ['NOW', D, '', 'Current date and time.'],
  ['SECOND', D, 'serial_number', 'Second, 0 to 59.'],
  ['TIME', D, 'hour, minute, second', 'A time from hour, minute and second.'],
  ['TIMEVALUE', D, 'time_text', 'Converts time text to a time.'],
  ['TODAY', D, '', 'Current date.'],
  ['WEEKDAY', D, 'serial_number, [return_type]', 'Day of the week as a number.'],
  ['WEEKNUM', D, 'serial_number, [return_type]', 'Week number of the year.'],
  ['WORKDAY', D, 'start_date, days, [holidays]', 'The date a number of working days away.'],
  ['WORKDAYINTL', D, 'start_date, days, [weekend], [holidays]', 'The date a number of working days away, with a custom weekend.'],
  ['YEAR', D, 'serial_number', 'Year of a date.'],
  ['YEARFRAC', D, 'start_date, end_date, [basis]', 'Fraction of a year between two dates.'],

  // Financial.
  ['EFFECT', F, 'nominal_rate, npery', 'Effective annual interest rate.'],
  ['FV', F, 'rate, nper, pmt, [pv], [type]', 'Future value of an investment.'],
  ['FVSCHEDULE', F, 'principal, schedule', 'Future value after a schedule of interest rates.'],
  ['IPMT', F, 'rate, per, nper, pv, [fv], [type]', 'Interest part of a payment for a period.'],
  ['IRR', F, 'values, [guess]', 'Internal rate of return of cash flows.'],
  ['ISPMT', F, 'rate, per, nper, pv', 'Interest paid in a period of a straight-line loan.'],
  ['MIRR', F, 'values, finance_rate, reinvest_rate', 'Modified internal rate of return.'],
  ['NOMINAL', F, 'effect_rate, npery', 'Nominal annual interest rate.'],
  ['NPER', F, 'rate, pmt, pv, [fv], [type]', 'Number of payment periods.'],
  ['NPV', F, 'rate, value1, [value2...]', 'Net present value of periodic cash flows.'],
  ['PDURATION', F, 'rate, pv, fv', 'Periods for an investment to reach a value.'],
  ['PMT', F, 'rate, nper, pv, [fv], [type]', 'Payment per period for a loan.'],
  ['PPMT', F, 'rate, per, nper, pv, [fv], [type]', 'Principal part of a payment for a period.'],
  ['PV', F, 'rate, nper, pmt, [fv], [type]', 'Present value of an investment.'],
  ['RATE', F, 'nper, pmt, pv, [fv], [type], [guess]', 'Interest rate per period.'],
  ['RRI', F, 'nper, pv, fv', 'Equivalent interest rate for growth of an investment.'],
  ['SLN', F, 'cost, salvage, life', 'Straight-line depreciation for one period.'],
  ['SYD', F, 'cost, salvage, life, per', "Sum-of-years' digits depreciation for a period."],
  ['TBILLEQ', F, 'settlement, maturity, discount', 'Bond-equivalent yield of a Treasury bill.'],
  ['TBILLPRICE', F, 'settlement, maturity, discount', 'Price of a Treasury bill per 100 face value.'],
  ['TBILLYIELD', F, 'settlement, maturity, pr', 'Yield of a Treasury bill.'],
  ['XIRR', F, 'values, dates, [guess]', 'Internal rate of return of irregular cash flows.'],
  ['XNPV', F, 'rate, values, dates', 'Net present value of irregular cash flows.'],

  // Engineering.
  ['BIN2DEC', E, 'number', 'Converts binary to decimal.'],
  ['BIN2HEX', E, 'number, [places]', 'Converts binary to hexadecimal.'],
  ['BIN2OCT', E, 'number, [places]', 'Converts binary to octal.'],
  ['BITAND', E, 'number1, number2', 'Bitwise AND of two numbers.'],
  ['BITLSHIFT', E, 'number, shift_amount', 'Shifts a number left by bits.'],
  ['BITOR', E, 'number1, number2', 'Bitwise OR of two numbers.'],
  ['BITRSHIFT', E, 'number, shift_amount', 'Shifts a number right by bits.'],
  ['BITXOR', E, 'number1, number2', 'Bitwise XOR of two numbers.'],
  ['COMPLEX', E, 'real_num, i_num, [suffix]', 'A complex number from real and imaginary parts.'],
  ['CONVERT', E, 'number, from_unit, to_unit', 'Converts a number between units.'],
  ['DEC2BIN', E, 'number, [places]', 'Converts decimal to binary.'],
  ['DEC2HEX', E, 'number, [places]', 'Converts decimal to hexadecimal.'],
  ['DEC2OCT', E, 'number, [places]', 'Converts decimal to octal.'],
  ['DELTA', E, 'number1, [number2]', '1 when two numbers are equal, otherwise 0.'],
  ['GESTEP', E, 'number, [step]', '1 when number is at least step, otherwise 0.'],
  ['HEX2BIN', E, 'number, [places]', 'Converts hexadecimal to binary.'],
  ['HEX2DEC', E, 'number', 'Converts hexadecimal to decimal.'],
  ['HEX2OCT', E, 'number, [places]', 'Converts hexadecimal to octal.'],
  ['IMABS', E, 'inumber', 'Absolute value of a complex number.'],
  ['IMAGINARY', E, 'inumber', 'Imaginary coefficient of a complex number.'],
  ['IMARGUMENT', E, 'inumber', 'Argument (angle) of a complex number, in radians.'],
  ['IMCONJUGATE', E, 'inumber', 'Complex conjugate.'],
  ['IMCOS', E, 'inumber', 'Cosine of a complex number.'],
  ['IMCOSH', E, 'inumber', 'Hyperbolic cosine of a complex number.'],
  ['IMCOT', E, 'inumber', 'Cotangent of a complex number.'],
  ['IMCSC', E, 'inumber', 'Cosecant of a complex number.'],
  ['IMCSCH', E, 'inumber', 'Hyperbolic cosecant of a complex number.'],
  ['IMDIV', E, 'inumber1, inumber2', 'Quotient of two complex numbers.'],
  ['IMEXP', E, 'inumber', 'Exponential of a complex number.'],
  ['IMLN', E, 'inumber', 'Natural logarithm of a complex number.'],
  ['IMLOG10', E, 'inumber', 'Base-10 logarithm of a complex number.'],
  ['IMLOG2', E, 'inumber', 'Base-2 logarithm of a complex number.'],
  ['IMPOWER', E, 'inumber, number', 'A complex number raised to a power.'],
  ['IMPRODUCT', E, 'inumber1, [inumber2...]', 'Product of complex numbers.'],
  ['IMREAL', E, 'inumber', 'Real coefficient of a complex number.'],
  ['IMSEC', E, 'inumber', 'Secant of a complex number.'],
  ['IMSECH', E, 'inumber', 'Hyperbolic secant of a complex number.'],
  ['IMSIN', E, 'inumber', 'Sine of a complex number.'],
  ['IMSINH', E, 'inumber', 'Hyperbolic sine of a complex number.'],
  ['IMSQRT', E, 'inumber', 'Square root of a complex number.'],
  ['IMSUB', E, 'inumber1, inumber2', 'Difference of two complex numbers.'],
  ['IMSUM', E, 'inumber1, [inumber2...]', 'Sum of complex numbers.'],
  ['IMTAN', E, 'inumber', 'Tangent of a complex number.'],
  ['OCT2BIN', E, 'number, [places]', 'Converts octal to binary.'],
  ['OCT2DEC', E, 'number', 'Converts octal to decimal.'],
  ['OCT2HEX', E, 'number, [places]', 'Converts octal to hexadecimal.'],
];

function parseSignature(signature: string): FunctionParam[] {
  if (signature === '') return [];
  return signature.split(', ').map((part) => {
    const optional = part.startsWith('[') && part.endsWith(']');
    const inner = optional ? part.slice(1, -1) : part;
    const repeating = inner.endsWith('...');
    return { name: repeating ? inner.slice(0, -3) : inner, optional, repeating };
  });
}

export const FUNCTION_CATALOG: ReadonlyMap<string, FunctionCatalogEntry> = new Map(
  ROWS.map(([name, category, signature, description]) => [
    name,
    { name, category, signature, description, params: parseSignature(signature) },
  ]),
);

export function getFunctionEntry(name: string): FunctionCatalogEntry | undefined {
  return FUNCTION_CATALOG.get(name.toUpperCase());
}

/**
 * Which parameter a zero-based argument index lands on. Past the declared
 * parameters, the index cycles through the trailing repeating group, so the
 * sixth argument of `SUMIFS` maps back to `criteria_range2`. Returns -1 when
 * the function takes no further arguments.
 */
export function paramIndexForArgument(entry: FunctionCatalogEntry, argIndex: number): number {
  const { params } = entry;
  if (argIndex < params.length) return argIndex;
  let groupStart = params.length;
  while (groupStart > 0 && params[groupStart - 1].repeating) groupStart -= 1;
  const groupSize = params.length - groupStart;
  if (groupSize === 0) return -1;
  return groupStart + ((argIndex - groupStart) % groupSize);
}
