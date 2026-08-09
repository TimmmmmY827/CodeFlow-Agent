import { Box, Text } from "ink";
import React from "react";

export interface StatusPanelProps {
  readonly title: string;
  readonly state: string;
  readonly detail: string;
}

export function StatusPanel({ title, state, detail }: StatusPanelProps): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{title}</Text>
      <Text>
        状态：<Text color="cyan">{state}</Text>
      </Text>
      <Text dimColor>{detail}</Text>
    </Box>
  );
}
