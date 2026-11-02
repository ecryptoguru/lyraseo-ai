# LyraSEO AI: model policy

Date: 2026-10-22 · Status: Azure AI Foundry / Azure OpenAI with the two selected models, $10 per user combined monthly testing budget and 25 Azure OpenAI API observations per user/month approved; routing and initial execution bounds selected in the engineering contracts; actual deployment/tool/tariff verification remains.

Phase scope follows [release phases](./release-phases.md). The approved split retains long briefs, Parallel research, cross-page strategy, generated schema drafts and measurement features in private phase 1 alongside bounded page rewrites and manual API/consumer observations. Only customer automation and advanced administration are newly deferred; model/provider choices and budget guards are unchanged. PostHog deferral does not defer product AI visibility or internal cost receipts.

Retention defaults are approved in [the retention/deletion policy](./data-retention-and-deletion.md): foreground Responses requests with `store: false` where supported, minimal provider context, no full request/debug logging, 90-day raw observation retention and compact evidence for longer-lived metrics. Azure's own storage, abuse-monitoring and caching terms apply; direct OpenAI account terms are not the processor contract for these calls. This does not claim zero provider retention or activated modified abuse monitoring. Do not reuse deleted source input or silently purchase a fresh observation to recreate historical evidence. No settings are configured during planning.

The founder selected Azure AI Foundry / Azure OpenAI as the sole LLM provider, using only OpenAI `gpt-6.1-sol` and `gpt-6-luna`. This replaces the earlier direct OpenAI endpoint assumption. Microsoft documentation lists both models; actual subscription access, deployment region/type, quota and tool support still require verification at setup. No Claude, GPT-6 Astra, direct Gemini or direct Perplexity API integration is selected. No API keys, paid calls, application implementation or provider provisioning were performed for this selection.

## 1. Simple Azure integration

Plan one LyraSEO AI-owned Azure OpenAI resource with two model deployments and one server-side client using the standard `openai` TypeScript SDK and Azure's `/openai/v1/` endpoint. The request's `model` field is the configured Azure deployment name, not necessarily the catalog model identifier. Keep only endpoint, server-side API key and the two deployment names in configuration; record the resolved model/version in receipts. Start with pay-as-you-go Standard capacity, subject to actual availability and pricing, rather than provisioned throughput. Azure resource region and deployment processing scope remain setup checks, not an India-only residency promise.

Keep the implementation to a small module for generation and observation calls. No additional LLM gateway, provider-routing framework, Foundry Agents service, Azure AI Search, vector store, multi-region failover or automatic provider fallback is selected. The planned job execution, bounded retries, schema validation and spend receipts are the intended supporting mechanisms. Azure resources, credentials and billing attribution stay independent from LyraShield. A server-side resource key is the simple initial authentication default; never ship it to the browser or store it in product rows/logs.

Sources: [Azure v1 API](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle), [endpoint and deployment-name configuration](https://learn.microsoft.com/en-us/azure/developer/ai/how-to/switching-endpoints), [Azure model catalog](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure?pivots=azure-direct-openai&view=foundry-classic).

## 2. Selected initial task routing

| Work | Model/service | Proposed configuration |
| ---- | ------------- | ---------------------- |
| Page rewrites, briefs and buyer-question synthesis | Azure deployment of `gpt-6.1-sol` | Azure Responses API, pay-as-you-go Standard, medium reasoning; selected evidence only |
| Complex finding explanations and cross-page editorial consistency | `gpt-6.1-sol` | Medium reasoning initially; high only after demonstrated benefit within approved budget |
| Bounded tagging, classification, field extraction and short transformations | Azure deployment of `gpt-6-luna` | Azure Responses API, pay-as-you-go Standard, low reasoning initially; escalate only through an explicit permitted workflow |
| Deterministic audit rules, scoring and technical resolution checks | Pure TypeScript | No model calls or model-generated score changes |
| Cited source discovery and extraction | Parallel Search/Extract | Explicit research job, source/freshness receipts; Sol synthesizes selected completed research |
| Consumer ChatGPT and Gemini observations | DataForSEO LLM Scraper | Provider-observed outputs; do not replace with generated OpenAI answers |
| Azure OpenAI API observation | Azure deployment of `gpt-6.1-sol` with a fixed Azure web-search profile | Separate observation configuration/cohort, tool spend caps and complete provenance; verify deployment support |

Luna is a supporting model, not an automatic first pass for every Sol request. Prefer one well-scoped generation with schema and evidence validation over an automatic multi-model chain. Routine API errors follow bounded retry policy; semantic uncertainty is not resolved by unlimited regeneration. No automatic cross-provider or expensive-model fallback is selected. If an optional regeneration uses Sol, show any additional customer usage first.

Validate reasoning efforts against the selected Azure deployment/version before calls; do not assume every direct OpenAI parameter is supported unchanged. Effort changes affect quality, latency and billable reasoning, so record effort alongside model, deployment/version, prompt and input versions. The defaults above are engineering recommendations, not measured latency guarantees.

## 3. Azure pricing and budget

Azure bills the LLM calls. Earlier direct OpenAI token prices, search fees and monthly arithmetic are superseded as operating estimates. Verify the selected Azure deployment type, region, model version, token tariff and any grounding/tool charges before reserving spend. Do not assume a cache hit, promotional credit or fixed price parity with the direct OpenAI API.

The approved ceiling remains $10 per user/month combined Azure OpenAI, Parallel and DataForSEO consumption, including 25 Azure OpenAI API observations per user/month. This is the existing budget and observation allocation carried to Azure, not another provider allowance. Keep token/deadline limits and simple admission/usage accounting; Azure budget alerts alone do not enforce a hard spending stop. No resource provisioning or purchase is authorized during planning.

Source: [Azure OpenAI pricing](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/). Actual account tariffs and access have not been inspected.

## 4. Generation and observation are distinct

Editorial requests have no browsing or publishing tools. They consume selected audit, GSC, observation or Parallel research snapshots. Store exact model/configuration, prompt version, input hash and output receipt, and validate factual grounding, schema and citation support. Model output cannot change deterministic audit scores.

Observation requests use a separate configuration and approved panel on the same Azure resource. Proposed initial profile is Azure Sol with explicit `web_search`. Record Azure as the provider, deployment/model/version, reasoning, search mode, citations, panel version, locale support, execution time and actual tool usage. Keep the profile fixed for cohort comparisons; changes create a new cohort. Azure OpenAI and direct OpenAI API observations are different acquisition profiles. Do not silently fall back to Luna on a failed Sol observation. A reused cached answer is not a fresh measurement.

Microsoft documents Azure web search as Bing grounding with separate terms and charges; current documentation says live external-web access is unsupported. Describe it as the configured Azure API observation, never a consumer ChatGPT measurement or proof of a newly fetched source. Verify tool support and permitted result storage for the actual deployment. Azure bills web search by Bing request counts reported in `tool_usage.web_search.num_requests`, not simply visible search actions; keep that count in cost receipts. If unsupported, mark the observation unavailable rather than adding a second provider or substituting a Parallel-grounded generation. [Azure web-search documentation](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/web-search).

The founder-approved initial surface matrix is below, with English and India as the pilot target market. Actual provider locality/tool settings remain verification items; India-focused API prompts are not proof of consumer geolocation.

| Surface | Acquisition | What it establishes |
| ------- | ----------- | ------------------- |
| Azure OpenAI Sol API | Azure Responses/web-search profile | Response for the configured Azure deployment and retrieval settings |
| Consumer ChatGPT | DataForSEO's supported LLM Scraper | Provider-observed ChatGPT result with recorded sampling/locality |
| Consumer Gemini | DataForSEO's supported LLM Scraper | Provider-observed Gemini result, without a direct Gemini API dependency |

The exact DataForSEO locality/mode and data-use contracts still need validation. Consumer Perplexity remains an explicit coverage gap. A direct Perplexity API integration would measure that API, not solve consumer-app coverage. Claude is not needed for the current generation or measurement contract. If any additional API observation is wanted later, approve it as a named surface with its own costs and cohort.

## 5. Parallel and DataForSEO boundaries

Parallel Search/Extract and DataForSEO remain approved external services. Their internal processing is governed by their contracts and is not a customer-selected OpenAI model configuration. Do not describe their outputs as generated by Sol/Luna. Avoid adding Parallel Task/Responses or DataForSEO LLM Responses generation for now; use Sol over selected research sources and the explicit observation contracts above.

## 6. Selected bounds and remaining verification

The [usage and cost policy](./usage-and-cost-policy.md) records the approved $10 per user combined monthly Azure OpenAI/Parallel/DataForSEO testing-consumption budget and 25 Azure OpenAI API observations per user/month. The per-user $8/$1/$1 split is approved. Editorial, research and helper work has no additional monthly count quota; it uses remaining provider budget. Runtime bounds and deadlines are engineering settings to verify, not further founder allowance decisions. No unrestricted model context, automatic deep research or unlimited rewriting is proposed. Use normalized relevant evidence rather than entire raw websites; preserve source references and escape untrusted page content.

After the planning decisions are finalized, evaluate the two models on representative LyraSEO AI fixtures for groundedness, usefulness, formatting/schema correctness, injection resistance, actual latency, retries and cost per accepted output. Select the lightest effort that meets the quality bar. Published provider descriptions and pricing do not prove LyraSEO AI-specific accuracy or performance. Model aliases/configuration changes require a deliberate regression review; do not invent a dated snapshot identifier if the provider has not published one.

Related: [full-version specification](./full-version-spec.md), [quality review](./product-quality-and-optimization.md), [PRD](./lyraseo-ai-prd.md).
