<script lang="ts">
import '@xterm/xterm/css/xterm.css';
import { EmptyScreen } from '@podman-desktop/ui-svelte';
import { FitAddon } from '@xterm/addon-fit';
import { AttachAddon } from '@xterm/addon-attach';
import { Terminal } from '@xterm/xterm';
import { onDestroy, onMount } from 'svelte';
import { router } from 'tinro';
import { bootcClient, rpcBrowser } from '../../api/client';
import { getTerminalTheme } from '../upstream/terminal-theme';
import DiskImageConnectionStatus from './DiskImageConnectionStatus.svelte';
import Link from '../Link.svelte';
import { Messages } from '/@shared/src/messages/Messages';
import type { Subscriber } from '/@shared/src/messages/MessageProxy';
import type { BootcBuildInfo } from '/@shared/src/models/bootc';

export let build: BootcBuildInfo;

// Terminal and WebSocket connection variables
let logsXtermDiv: HTMLDivElement;
let noLogs = true;
let resizeObserver: ResizeObserver;
let termFit: FitAddon;
let attachAddon: AttachAddon;
let logsTerminal: Terminal;
let socket: WebSocket;
let launchInProgress = false;

// Status information regarding any VM launch errors (since we subscribe and get the notification)
let connectionStatus = '';
let socketStatus = '';
let vmLaunchError: string;
let vmLaunchPrereqs: string | undefined;
let notifySubscriber: Subscriber;
const VM_LAUNCH_ERROR_MESSAGE = 'VM launch error';
const GUIDE_LINK = 'https://github.com/containers/podman-desktop-extension-bootc/blob/main/docs/vm_launcher.md';

// This is an issue with xterm not resizing properly when first initializing / loading
// the terminal due to how we add padding. We must therefore call fit() approx 10ms after
// initial loading to make sure the terminal is properly sized.
// this is only called once when switching from no logs to logs
$: if (noLogs === false) {
  setTimeout(() => {
    termFit?.fit();
  }, 10);
}

// Event handlers for the WebSocket connection
// which are needed to update the connection status
function closeHandler(event: CloseEvent) {
  connectionStatus = 'VM stopped';
}

function openHandler(event: Event) {
  connectionStatus = 'VM started';
  noLogs = false;
}

function errorHandler(event: Event) {
  console.error('VM WebSocket error:', event);
  connectionStatus = 'VM error';
}

// Function that will check to see if a port is available before connecting and updates the connection status appropriately.
// before trying to connect.
async function waitForPort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const interval = setInterval(() => {
      // If connection status = "VM launch error", stop checking the port.
      if (connectionStatus === VM_LAUNCH_ERROR_MESSAGE) {
        clearInterval(interval);
        resolve(false);
      }

      // Attempt to create a WebSocket connection.
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);

      socket.onopen = () => {
        clearInterval(interval);
        resolve(true);
        socket.close();
      };

      socket.onerror = () => {
        // Keep the interval running, and no need to clear on error.
        socket.close(); // Close the socket when an error occurs.
      };
    }, 1000); // Retry every 1 second.
  });
}

async function initTerminal() {
  // If there is a missing element for the terminal / for some reason the page does not load correctly,
  // end early.
  if (!logsXtermDiv) {
    console.log('Missing xterm div, exiting...');
    return;
  }

  // Retrieve the user configuration settings for the terminal to match the rest of Podman Desktop.
  const fontSize = (await bootcClient.getConfigurationValue('terminal', 'integrated.fontSize')) as number;
  const lineHeight = (await bootcClient.getConfigurationValue('terminal', 'integrated.lineHeight')) as number;

  // Initialize the terminal with the correct theme.
  // we set disableStdin to true since we are using the attach addon which causes conflict if
  // we try to use stdin.
  logsTerminal = new Terminal({
    fontSize: fontSize,
    lineHeight: lineHeight,
    theme: getTerminalTheme(),
    disableStdin: true,
  });

  // Wait for the port to become available before trying to connect to the socket, as there is
  // no point in trying the connection until the port is available.
  // exit early if so.
  socketStatus = 'Waiting for WebSocket connection to become available...';
  const portAvailable = await waitForPort(45252);
  if (!portAvailable) {
    console.error('Port 45252 is not available, exiting...');
    return;
  }

  // Try to connect to the socket and error if we are unable to / end early.
  try {
    socket = new WebSocket(`ws://127.0.0.1:45252`);
    socket.binaryType = 'arraybuffer';

    // Bind the event handlers
    socket.onclose = closeHandler;
    socket.onopen = openHandler;
    socket.onerror = errorHandler;
    socketStatus = 'WebSocket connection established, waiting for VM to boot...';
  } catch (error) {
    vmLaunchError = 'Failed to connect to the socket';
    console.error('Failed to connect to the socket:', error);
    return;
  }

  // Addons for the terminal (fit and attach)
  termFit = new FitAddon();
  logsTerminal.loadAddon(termFit);
  logsTerminal.open(logsXtermDiv);

  // Call fit addon each time we resize the window
  window.addEventListener('resize', () => {
    termFit.fit();
  });
  termFit.fit();

  // Addon for attaching to the socket
  // we load this LAST so that the resizer works correctly (as GRUB output is not resized correctly on first boot)
  // to avoid any conflicts with the resizer.
  attachAddon = new AttachAddon(socket);
  logsTerminal.loadAddon(attachAddon);

  // This is required for keyboard input to work since we are using the attach addon
  logsTerminal.onKey((e: any) => {
    e = e.key;
    if (socket !== undefined) {
      const encoder = new TextEncoder();
      const binaryData = encoder.encode(e);
      socket.send(binaryData.buffer);
    }
  });

  // Allow copy / paste support with Ctrl+V
  logsTerminal.attachCustomKeyEventHandler((arg: KeyboardEvent) => {
    // Allow copy and paste from the ctrl key (windows and linux)
    // and "meta" key (macOS). Sometimes on macOS the ctrl key is used, so we safely assume that either meta or ctrl is meant
    // for paste.
    if ((arg.ctrlKey || arg.metaKey) && arg.code === 'KeyV' && arg.type === 'keydown') {
      bootcClient.readFromClipboard().then(clipboardText => {
        // Send to socket
        if (socket !== undefined) {
          const encoder = new TextEncoder();
          const binaryData = encoder.encode(clipboardText);
          socket.send(binaryData.buffer);
        }
      });
    }
    return true;
  });
}

// Launch the VM with the folder location and architecture required.
async function launchVM(build: BootcBuildInfo): Promise<void> {
  launchInProgress = true;

  // This is launched IN THE BACKGROUND. We do not wait for the VM to boot before showing the terminal.
  // we instead are notified by subscribing to Messages.MSG_VM_LAUNCH_ERROR messages from RPC
  bootcClient.launchVM(build);

  // Initialize the terminal so it awaits the websocket connection.
  await initTerminal();

  // To avoid a blank terminal wait until terminal has logs and and then show it
  // logs.terminal.buffer.normal will contain the "ascii cursor" with a value of 1 until there is more logs.
  // we wait until buffer.normal.length is more than 1.
  const startTime = Date.now();
  const timeout = 30_000; // 30 seconds

  while (logsTerminal.buffer.normal.length < 1) {
    if (Date.now() - startTime > timeout) {
      console.error('Timeout waiting for terminal logs');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Reset the terminal if we are booting an arm64 VM on macOS
  // see function for more information why this is necessary.
  if (build.arch === 'arm64' && (await bootcClient.isMac())) {
    await resetTerminalTheme();
  }
}

// This is a temporary workaround for a terminal theme issue that ONLY happens when arm64 VMs are launched
// on macOS. The reasoning is that it is for some reason using the default terminal theme despite -nographic being set.
// this could possibly be because we use host CPU and memory as well as the 'virt' module for the VM to be working / launched
// correctly in accelerated mode.
//
// To work "around" this, we reset the theme 10 lines after the VM is booted in order to clear any colourization ASCII characters that may
// be present in the terminal.
async function resetTerminalTheme(): Promise<void> {
  // Wait until we have more than 100 lines in the buffer before resetting the terminal
  while (logsTerminal.buffer.normal.length < 100) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Reset the terminal
  logsTerminal.reset();
}

async function stopVM(): Promise<void> {
  await bootcClient.stopCurrentVM();
}

onMount(async () => {
  // We do this FIRST as we want to subscribe to the VM_LAUNCH_ERROR message
  // as sometimes it launches "too fast" for us to catch the message.
  // Subscribe for any terminal errors when trying to deploy the VM
  // since these are not caught by the WebSocket error handler
  // and instead notified
  notifySubscriber = rpcBrowser.subscribe(Messages.MSG_VM_LAUNCH_ERROR, async msg => {
    // If msg.error contains an error, we will display it to the user
    if (msg.error) {
      connectionStatus = VM_LAUNCH_ERROR_MESSAGE;
      vmLaunchError = `${VM_LAUNCH_ERROR_MESSAGE}: ${msg.error}`;
      // Set noLogs to true so that the terminal is not shown
      // and we can show the error message instead.
      noLogs = true;
    }
  });

  // Resize the terminal each time we change the div size
  resizeObserver = new ResizeObserver(() => {
    termFit?.fit();
  });

  // Observe the terminal div
  resizeObserver.observe(logsXtermDiv);

  // Launch the VM if we pass all the prerequisites, otherwise we will show the empty screen with content / information checks.
  vmLaunchPrereqs = await bootcClient.checkVMLaunchPrereqs(build);

  if (!vmLaunchPrereqs) {
    await launchVM(build);
  }
});

onDestroy(() => {
  // Make sure that we stop the VM / kill it
  // run this in the background since we do not want to wait for the VM to stop before closing the page.
  stopVM();

  // Clean up all other connections and resources
  resizeObserver?.unobserve(logsXtermDiv);
  socket?.close();
  logsTerminal?.dispose();
  notifySubscriber?.unsubscribe();
});

export function goToHomePage(): void {
  router.goto('/');
}
</script>

{#if vmLaunchPrereqs}
  <EmptyScreen icon={undefined} title="Prerequisites not met" message={vmLaunchPrereqs}>
    <div class="mt-2">
      <p class="text-md">
        View our guide for further information on completing the prerequisites: <Link externalRef={GUIDE_LINK}
          >Virtual Machine Launcher BootC Guide</Link
        >.
      </p>
    </div>
  </EmptyScreen>
{:else if vmLaunchError}
  <EmptyScreen icon={undefined} title="Virtual Machine launch error" message={vmLaunchError}>
    <!-- View our guide for troubleshooting steps, if not open an issue. -->
    <div class="mt-2">
      <p class="text-md">
        View our guide for further information on troubleshooting steps: <Link externalRef={GUIDE_LINK}
          >Virtual Machine Launcher BootC Guide.</Link> If you are still experiencing issues, please open an issue on our
        <Link externalRef="https://github.com/containers/podman-desktop-extension-bootc">GitHub repository</Link>.
      </p>
    </div>
  </EmptyScreen>
{:else if noLogs}
  <EmptyScreen
    icon={undefined}
    title="Loading..."
    message={socketStatus ? socketStatus : 'Checking prerequisites and system information...'} />
{/if}

<div class="absolute top-[70px] right-[5px]">
  <DiskImageConnectionStatus status={connectionStatus} />
</div>
<div
  class="min-w-full flex flex-col p-[5px] pr-0 bg-[var(--pd-terminal-background)]"
  class:invisible={noLogs}
  class:h-0={noLogs}
  class:h-full={!noLogs}
  bind:this={logsXtermDiv}>
</div>
