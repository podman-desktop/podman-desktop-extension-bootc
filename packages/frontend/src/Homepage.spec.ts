/**********************************************************************
 * Copyright (C) 2024 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 * * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

import { vi, test, expect } from 'vitest';
import { screen, render } from '@testing-library/svelte';
import Homepage from './Homepage.svelte';
import type { BootcBuildInfo } from '/@shared/src/models/bootc';
import { bootcClient } from './api/client';
import { beforeEach } from 'node:test';

const mockHistoryInfo: BootcBuildInfo[] = [
  {
    name: 'image1',
    engineId: 'engine1',
    tag: 'latest',
    type: 'iso',
    folder: '/tmp/image1',
    arch: 'x86_64',
  },
  {
    name: 'image2',
    engineId: 'engine2',
    tag: 'latest',
    type: 'iso',
    folder: '/tmp/image1',
    arch: 'x86_64',
  },
];

vi.mock('./api/client', async () => {
  return {
    bootcClient: {
      listHistoryInfo: vi.fn(),
      deleteBuilds: vi.fn(),
    },
    rpcBrowser: {
      subscribe: () => {
        return {
          unsubscribe: () => {},
        };
      },
    },
  };
});

async function waitRender(customProperties: object): Promise<void> {
  const result = render(Homepage, { ...customProperties });
  // wait that result.component.$$.ctx[2] is set
  while (result.component.$$.ctx[2] === undefined) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

test('Homepage renders correctly with no past builds', async () => {
  vi.mocked(bootcClient.listHistoryInfo).mockResolvedValue([]);

  await waitRender(Homepage);

  // No bootable container builds found should be present
  expect(screen.queryByText('No bootable container builds found')).not.toBeNull();
});

test('Homepage renders correctly with multiple rows', async () => {
  vi.mocked(bootcClient.listHistoryInfo).mockResolvedValue(mockHistoryInfo);

  await waitRender(Homepage);

  // Wait until header 'No bootable container builds found' is removed
  // as that means it's fully loaded
  while (screen.queryByText('No bootable container builds found')) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Name 'image1:latest' should be present
  expect(screen.queryByText('image1:latest')).not.toBeNull();

  // Name 'image2:latest' should be present
  expect(screen.queryByText('image2:latest')).not.toBeNull();
});

test('Test clicking on delete button', async () => {
  vi.mocked(bootcClient.listHistoryInfo).mockResolvedValue(mockHistoryInfo);
  vi.mocked(bootcClient.deleteBuilds).mockResolvedValue(await Promise.resolve());

  await waitRender(Homepage);

  // Wait until header 'No bootable container builds found' is removed
  // as that means it's fully loaded
  while (screen.queryByText('No bootable container builds found')) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // spy on deleteBuild function
  const spyOnDelete = vi.spyOn(bootcClient, 'deleteBuilds');

  // Click on delete button
  const deleteButton = screen.getAllByRole('button', { name: 'Delete Build' })[0];
  deleteButton.click();

  expect(spyOnDelete).toHaveBeenCalled();
});
