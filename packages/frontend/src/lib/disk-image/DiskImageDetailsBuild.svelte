<script lang="ts">
import '@xterm/xterm/css/xterm.css';

import { EmptyScreen } from '@podman-desktop/ui-svelte';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { onDestroy, onMount } from 'svelte';
import { router } from 'tinro';
import { bootcClient } from '/@/api/client';
import { getTerminalTheme } from '/@/lib/upstream/terminal-theme';

export let folder: string | undefined;

// Log
let logsXtermDiv: HTMLDivElement;
let noLogs = true;
let previousLogs: string = '';
const refreshInterval = 2000;

// Terminal resize
let resizeObserver: ResizeObserver;
let termFit: FitAddon;

let logsTerminal: Terminal;
let logInterval: NodeJS.Timeout;

// This is an issue with xterm not resizing properly when first initializing / loading
// the terminal due to how we add padding. We must therefore call fit() approx 10ms after
// initial loading to make sure the terminal is properly sized.
// this is only called once when switching from no logs to logs
$: if (noLogs === false) {
  setTimeout(() => {
    termFit?.fit();
  }, 10);
}

async function fetchFolderLogs() {
  if (!folder) {
    return;
  }

  const logs = await bootcClient.loadLogsFromFolder(folder);

  // We will write only the new logs to the terminal,
  // this is a simple way of updating the logs as we update it by calling the function
  // every 2 seconds instead of setting up a file watcher (unable to do so through RPC calls, due to long-running process)
  if (logs !== previousLogs) {
    // Write only the new logs to the log
    const newLogs = logs.slice(previousLogs.length);
    logsTerminal.write(newLogs);
    previousLogs = logs; // Update the stored logs
    noLogs = false; // Make sure that the logs are visible
  }
}

async function refreshTerminal() {
  // missing element, return
  if (!logsXtermDiv) {
    console.log('missing xterm div, exiting...');
    return;
  }

  // Retrieve the user configuration settings for the terminal to match the rest of Podman Desktop.
  const fontSize = (await bootcClient.getConfigurationValue('terminal', 'integrated.fontSize')) as number;
  const lineHeight = (await bootcClient.getConfigurationValue('terminal', 'integrated.lineHeight')) as number;

  logsTerminal = new Terminal({
    fontSize: fontSize,
    lineHeight: lineHeight,
    disableStdin: true,
    theme: getTerminalTheme(),
    convertEol: true,
  });
  termFit = new FitAddon();
  logsTerminal.loadAddon(termFit);

  logsTerminal.open(logsXtermDiv);

  // Disable cursor as we are just reading the logs
  logsTerminal.write('\x1b[?25l');

  // Call fit addon each time we resize the window
  window.addEventListener('resize', () => {
    termFit.fit();
  });
  termFit.fit();
}

onMount(async () => {
  // Refresh the terminal on initial load
  await refreshTerminal();

  // Fetch logs initially and set up the interval to run every 2 seconds
  // we do this to avoid having to setup a file watcher since long-running commands to the backend is
  // not possible through RPC calls (yet).
  fetchFolderLogs();
  logInterval = setInterval(fetchFolderLogs, refreshInterval);

  // Resize the terminal each time we change the div size
  resizeObserver = new ResizeObserver(() => {
    termFit?.fit();
  });

  // Observe the terminal div
  resizeObserver.observe(logsXtermDiv);
});

onDestroy(() => {
  // Cleanup the observer on destroy
  resizeObserver?.unobserve(logsXtermDiv);

  // Clear the interval when the component is destroyed
  clearInterval(logInterval);
});

export function goToHomePage(): void {
  router.goto('/');
}
</script>

<EmptyScreen
  icon={undefined}
  title="No log file"
  message="Unable to read image-build.log file from {folder}"
  hidden={noLogs === false} />

<div
  class="min-w-full flex flex-col p-[5px] pr-0 bg-[var(--pd-terminal-background)]"
  class:invisible={noLogs === true}
  class:h-0={noLogs === true}
  class:h-full={noLogs === false}
  bind:this={logsXtermDiv}>
</div>
