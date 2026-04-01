#!/usr/bin/env bun
/**
 * MCP Server for mails-gtm-agent.
 *
 * Wraps the deployed Worker HTTP API as MCP tools so Claude Code,
 * Cursor, and other AI assistants can manage campaigns directly.
 *
 * Usage:
 *   MAILS_GTM_URL=https://your-worker.workers.dev MAILS_GTM_TOKEN=your-token bun mcp/index.ts
 *
 * Add to claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "mails-gtm": {
 *         "command": "bun",
 *         "args": ["mcp/index.ts"],
 *         "env": {
 *           "MAILS_GTM_URL": "https://your-worker.workers.dev",
 *           "MAILS_GTM_TOKEN": "your-admin-token"
 *         }
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const API_URL = process.env.MAILS_GTM_URL || 'https://mails-gtm-agent.genedai.workers.dev'
const API_TOKEN = process.env.MAILS_GTM_TOKEN || ''

async function apiCall(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { status: res.status, body: text }
  }
}

const server = new Server(
  { name: 'mails-gtm-agent', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'campaign_list',
      description: 'List all campaigns with their status, contact counts, and performance stats.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'campaign_create',
      description: 'Create a new AI-driven outreach campaign. Provide a product URL and the agent will auto-generate a knowledge base.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Campaign name' },
          product_url: { type: 'string', description: 'Product homepage URL (agent will crawl and extract knowledge)' },
          conversion_url: { type: 'string', description: 'URL where leads should convert (signup/pricing page)' },
          from_email: { type: 'string', description: 'Sender email address' },
          physical_address: { type: 'string', description: 'Physical address for CAN-SPAM compliance' },
        },
        required: ['name', 'product_url', 'from_email', 'physical_address'],
      },
    },
    {
      name: 'campaign_details',
      description: 'Get detailed info about a campaign including knowledge base and configuration.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          campaign_id: { type: 'string', description: 'Campaign ID' },
        },
        required: ['campaign_id'],
      },
    },
    {
      name: 'campaign_stats',
      description: 'Get campaign performance statistics: sent, clicked, replied, converted counts.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          campaign_id: { type: 'string', description: 'Campaign ID' },
        },
        required: ['campaign_id'],
      },
    },
    {
      name: 'campaign_start',
      description: 'Start a campaign. The agent will begin autonomous outreach.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          campaign_id: { type: 'string', description: 'Campaign ID' },
        },
        required: ['campaign_id'],
      },
    },
    {
      name: 'campaign_pause',
      description: 'Pause a running campaign.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          campaign_id: { type: 'string', description: 'Campaign ID' },
        },
        required: ['campaign_id'],
      },
    },
    {
      name: 'contacts_import',
      description: 'Import contacts from CSV data into a campaign. CSV must have email column, optionally name, company, role.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          campaign_id: { type: 'string', description: 'Campaign ID to import contacts into' },
          csv: { type: 'string', description: 'CSV data string with header row (email,name,company,role)' },
        },
        required: ['campaign_id', 'csv'],
      },
    },
    {
      name: 'campaign_decisions',
      description: 'View recent agent decisions (reasoning, angles, actions) for a campaign.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          campaign_id: { type: 'string', description: 'Campaign ID' },
        },
        required: ['campaign_id'],
      },
    },
    {
      name: 'campaign_preview',
      description: 'Preview what emails the agent would generate for N contacts without actually sending.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          campaign_id: { type: 'string', description: 'Campaign ID' },
          count: { type: 'number', description: 'Number of previews to generate (default: 3)' },
        },
        required: ['campaign_id'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    let result: unknown

    switch (name) {
      case 'campaign_list':
        result = await apiCall('/api/campaign/list')
        break

      case 'campaign_create':
        result = await apiCall('/api/campaign/create', 'POST', {
          name: args?.name,
          product_url: args?.product_url,
          conversion_url: args?.conversion_url,
          from_email: args?.from_email,
          physical_address: args?.physical_address,
          engine: 'agent',
          ai_generate: true,
        })
        break

      case 'campaign_details':
        result = await apiCall(`/api/campaign/${args?.campaign_id}`)
        break

      case 'campaign_stats':
        result = await apiCall(`/api/campaign/${args?.campaign_id}/stats`)
        break

      case 'campaign_start':
        result = await apiCall(`/api/campaign/${args?.campaign_id}/start`, 'POST')
        break

      case 'campaign_pause':
        result = await apiCall(`/api/campaign/${args?.campaign_id}/pause`, 'POST')
        break

      case 'contacts_import':
        result = await apiCall('/api/contacts/import', 'POST', {
          campaign_id: args?.campaign_id,
          csv: args?.csv,
        })
        break

      case 'campaign_decisions':
        result = await apiCall(`/api/campaign/${args?.campaign_id}/decisions`)
        break

      case 'campaign_preview':
        result = await apiCall(`/api/campaign/${args?.campaign_id}/preview`, 'POST', {
          count: args?.count || 3,
        })
        break

      default:
        return {
          content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
          isError: true,
        }
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    }
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      isError: true,
    }
  }
})

async function main() {
  if (!API_TOKEN) {
    console.error('MAILS_GTM_TOKEN is required. Set it in your environment.')
    process.exit(1)
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)
