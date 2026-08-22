# Label parser

Initialize a minimal Go module and implement package `labels`.

Export `Parse(values []string) (map[string]string, error)`. Each item must contain one non-empty `key=value` pair, surrounding whitespace is trimmed, later duplicate keys replace earlier values, and malformed input returns an error without a partial result.
