import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer'

import type {
  DesktopApi,
  ModelMappingsConfigOutcome,
  ModelMappingsSaveOutcome,
} from '../../shared-types'
import { LanguageProvider } from '../src/contexts/LanguageContext'
import ModelMappingsPage from '../src/pages/ModelMappingsPage'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type ModelMappingsApi = Pick<
  DesktopApi,
  'getModelMappingsConfig' | 'saveModelMappings'
>

function renderedText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : renderedText(child)))
    .join('')
}

function findButton(
  renderer: ReactTestRenderer,
  label: string,
  index = 0,
): ReactTestInstance {
  const buttons = renderer.root
    .findAllByType('button')
    .filter((button) => renderedText(button).trim() === label)
  const button = buttons[index]
  expect(button).toBeDefined()
  return button
}

async function clickButton(button: ReactTestInstance): Promise<void> {
  const onClick = (button.props as { onClick?: () => Promise<void> | void })
    .onClick
  if (!onClick) throw new Error('Button does not expose an onClick handler')
  await act(async () => {
    await onClick()
  })
}

async function changeInput(
  input: ReactTestInstance,
  value: string,
): Promise<void> {
  const onChange = (
    input.props as {
      onChange?: (event: { target: { value: string } }) => void
    }
  ).onChange
  if (!onChange) throw new Error('Input does not expose an onChange handler')
  await act(async () => {
    onChange({ target: { value } })
  })
}

function inputValue(input: ReactTestInstance): unknown {
  return (input.props as { value: unknown }).value
}

function inputInvalid(input: ReactTestInstance): unknown {
  return (input.props as { 'aria-invalid': unknown })['aria-invalid']
}

async function mountModelMappingsPage(api: ModelMappingsApi): Promise<{
  cleanup: () => void
  renderer: ReactTestRenderer
}> {
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronAPI: api },
    writable: true,
  })

  let renderer: ReactTestRenderer | undefined
  await act(async () => {
    renderer = create(
      createElement(
        LanguageProvider,
        null,
        createElement(ModelMappingsPage, { serverRunning: true }),
      ),
    )
    await Promise.resolve()
  })
  if (!renderer) throw new Error('Model mappings page did not mount')

  return {
    cleanup: () => {
      act(() => renderer?.unmount())
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: previousWindow,
        writable: true,
      })
    },
    renderer,
  }
}

function createSuccessfulSave(
  modelMappings: Record<string, string>,
): ModelMappingsSaveOutcome {
  return {
    ok: true,
    result: {
      catalogRefresh: {
        clientVersion: '0.144.2',
        degraded: false,
        inputRevision: 2,
        modelCount: Object.keys(modelMappings).length,
        path: '/tmp/models.json',
        restartRequired: false,
        status: 'unchanged',
      },
      configPath: '/tmp/config.json',
      modelMappings,
    },
  }
}

describe('model mappings page', () => {
  test('loads mappings and lets the user edit, add, remove, and save rows', async () => {
    const savedMappings: Array<Record<string, string>> = []
    const api: ModelMappingsApi = {
      getModelMappingsConfig: () =>
        Promise.resolve({
          config: {
            configPath: '/tmp/config.json',
            modelMappings: { alias: 'provider/old' },
          },
          ok: true,
        }),
      saveModelMappings: (modelMappings) => {
        savedMappings.push(modelMappings)
        return Promise.resolve(createSuccessfulSave(modelMappings))
      },
    }
    const { cleanup, renderer } = await mountModelMappingsPage(api)

    try {
      expect(renderer.root.findAllByType('input').map(inputValue)).toEqual([
        'alias',
        'provider/old',
      ])
      expect(renderedText(renderer.root)).toContain('/tmp/config.json')

      await changeInput(renderer.root.findAllByType('input')[1], 'provider/new')
      await clickButton(findButton(renderer, 'Add mapping'))
      const inputs = renderer.root.findAllByType('input')
      await changeInput(inputs[2], 'fresh')
      await changeInput(inputs[3], 'provider/fresh')
      await clickButton(findButton(renderer, 'Remove'))
      await clickButton(findButton(renderer, 'Save'))

      expect(savedMappings).toEqual([{ fresh: 'provider/fresh' }])
      expect(renderer.root.findAllByType('input').map(inputValue)).toEqual([
        'fresh',
        'provider/fresh',
      ])
      expect(renderedText(renderer.root)).toContain(
        'Saved through the service API.',
      )
    } finally {
      cleanup()
    }
  })

  test('shows a structured load error without inventing editable rows', async () => {
    const loadOutcome: ModelMappingsConfigOutcome = {
      error: {
        diagnostics: [
          { code: 'chain', source: 'alias', target: 'provider/model' },
        ],
        kind: 'validation_failed',
        message: 'Invalid model mappings.',
      },
      ok: false,
    }
    const { cleanup, renderer } = await mountModelMappingsPage({
      getModelMappingsConfig: () => Promise.resolve(loadOutcome),
      saveModelMappings: () =>
        Promise.reject(new Error('save should not be called')),
    })

    try {
      expect(renderedText(renderer.root)).toContain(
        'Failed to load model mappings: Invalid model mappings.',
      )
      expect(renderer.root.findAllByType('input')).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  test('blocks duplicate requested models before invoking save', async () => {
    let saveCalls = 0
    const { cleanup, renderer } = await mountModelMappingsPage({
      getModelMappingsConfig: () =>
        Promise.resolve({
          config: {
            configPath: '/tmp/config.json',
            modelMappings: { alpha: 'provider/a', beta: 'provider/b' },
          },
          ok: true,
        }),
      saveModelMappings: () => {
        saveCalls += 1
        return Promise.resolve(createSuccessfulSave({}))
      },
    })

    try {
      await changeInput(renderer.root.findAllByType('input')[2], 'alpha')
      await clickButton(findButton(renderer, 'Save'))

      expect(saveCalls).toBe(0)
      expect(renderedText(renderer.root)).toContain(
        'Duplicate requested model: alpha',
      )
      expect(
        renderer.root
          .findAllByType('input')
          .filter(({ props }) => props['aria-invalid'] === true),
      ).toHaveLength(4)
    } finally {
      cleanup()
    }
  })

  test('maps save diagnostics back to the exact rejected row', async () => {
    const { cleanup, renderer } = await mountModelMappingsPage({
      getModelMappingsConfig: () =>
        Promise.resolve({
          config: {
            configPath: '/tmp/config.json',
            modelMappings: {
              alias: 'provider/model',
              other: 'provider/other',
            },
          },
          ok: true,
        }),
      saveModelMappings: () =>
        Promise.resolve({
          error: {
            diagnostics: [
              {
                code: 'chain',
                source: 'alias',
                target: 'provider/model',
              },
            ],
            kind: 'validation_failed',
            message: 'Invalid model mappings.',
          },
          ok: false,
        }),
    })

    try {
      await clickButton(findButton(renderer, 'Save'))

      expect(renderedText(renderer.root)).toContain(
        'Failed to save model mappings: Invalid model mappings.',
      )
      expect(renderer.root.findAllByProps({ role: 'alert' })).toHaveLength(1)
      expect(renderedText(renderer.root.findByProps({ role: 'alert' }))).toBe(
        'chain · source="alias" · target="provider/model"',
      )
      expect(renderer.root.findAllByType('input').map(inputInvalid)).toEqual([
        true,
        true,
        false,
        false,
      ])
    } finally {
      cleanup()
    }
  })
})
