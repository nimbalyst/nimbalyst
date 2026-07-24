# ClaudeCodeProvider Architecture Diagram

## Current Architecture

```mermaid
graph TB
    subgraph "ClaudeCodeProvider (3,612 lines)"
        CCP[ClaudeCodeProvider<br/>Main Class]

        subgraph "Core Methods"
            SM[sendMessage<br/>~1,700 lines]
            CTH[createCanUseToolHandler<br/>~350 lines]
            MCP[getMcpServersConfig<br/>~140 lines]
            UI[User Interactions<br/>~340 lines]
        end

        subgraph "Static Dependencies (Injected)"
            SD1[mcpConfigLoader]
            SD2[trustChecker]
            SD3[patternSaver/Checker]
            SD4[imageCompressor]
            SD5[shellEnvironmentLoader]
        end

        CCP --> SM
        CCP --> CTH
        CCP --> MCP
        CCP --> UI
    end

    subgraph "Extracted Services (Already Done)"
        TM[TeammateManager<br/>1,726 lines]
        TPS[ToolPermissionService<br/>694 lines]
        ATH[AgentToolHooks<br/>880 lines]
    end

    subgraph "Claude Agent SDK"
        SDK[query function<br/>subprocess spawning]
    end

    CCP --> TM
    CCP --> TPS
    CCP --> ATH
    CCP --> SDK

    SD1 --> MCP
    SD2 --> TPS
    SD3 --> TPS
    SD4 --> SM
    SD5 --> MCP

    style CCP fill:#fecaca
    style TM fill:#86efac
    style TPS fill:#86efac
    style ATH fill:#86efac
    style MCP fill:#fcd34d
    style UI fill:#f9a8d4
```

## Proposed Architecture (After Phase 1)

```mermaid
graph TB
    subgraph "ClaudeCodeProvider (3,470 lines)"
        CCP2[ClaudeCodeProvider<br/>Main Class]

        subgraph "Core Methods"
            SM2[sendMessage<br/>~1,700 lines]
            CTH2[createCanUseToolHandler<br/>~350 lines]
            UI2[User Interactions<br/>~340 lines]
        end
    end

    subgraph "Extracted Services"
        TM2[TeammateManager<br/>1,726 lines]
        TPS2[ToolPermissionService<br/>694 lines]
        ATH2[AgentToolHooks<br/>880 lines]
        MCS[McpConfigService<br/>140 lines<br/>NEW ✨]
    end

    subgraph "Future Providers"
        CP[CodexProvider<br/>Will use MCP]
        FP[Future Providers]
    end

    subgraph "Claude Agent SDK"
        SDK2[query function]
    end

    CCP2 --> SM2
    CCP2 --> CTH2
    CCP2 --> UI2
    CCP2 --> TM2
    CCP2 --> TPS2
    CCP2 --> ATH2
    CCP2 --> MCS
    CCP2 --> SDK2

    CP -.-> MCS
    CP -.-> TPS2
    CP -.-> ATH2
    FP -.-> MCS
    FP -.-> TPS2
    FP -.-> ATH2

    style CCP2 fill:#fecaca
    style MCS fill:#fcd34d
    style TM2 fill:#86efac
    style TPS2 fill:#86efac
    style ATH2 fill:#86efac
    style CP fill:#93c5fd
    style FP fill:#93c5fd
```

## Service Dependency Graph

```mermaid
graph LR
    subgraph "Providers"
        CC[ClaudeCodeProvider]
        CX[CodexProvider]
    end

    subgraph "Shared Services"
        MCS[McpConfigService]
        TPS[ToolPermissionService]
        ATH[AgentToolHooks]
    end

    subgraph "Provider-Specific Services"
        TM[TeammateManager<br/>Claude Code only]
    end

    subgraph "Static Dependencies"
        TC[trustChecker]
        PS[patternSaver]
        PC[patternChecker]
        MCL[mcpConfigLoader]
    end

    CC --> MCS
    CC --> TPS
    CC --> ATH
    CC --> TM

    CX --> MCS
    CX --> TPS
    CX --> ATH

    MCS --> MCL
    TPS --> TC
    TPS --> PS
    TPS --> PC
    ATH --> TC
    ATH --> PS
    ATH --> PC

    style CC fill:#fecaca
    style CX fill:#93c5fd
    style MCS fill:#fcd34d
    style TPS fill:#86efac
    style ATH fill:#86efac
    style TM fill:#c4b5fd
```

## Protocol Pattern (CodexProvider Model)

```mermaid
graph TB
    subgraph "Provider Layer"
        P[Provider<br/>Business Logic]
    end

    subgraph "Protocol Layer"
        PR[Protocol Interface<br/>AgentProtocol]
        CSDK[ClaudeSDKProtocol]
        CXSDK[CodexSDKProtocol]
    end

    subgraph "SDK Layer"
        SDK1[Claude Agent SDK]
        SDK2[OpenAI Codex SDK]
    end

    P --> PR
    PR --> CSDK
    PR --> CXSDK
    CSDK --> SDK1
    CXSDK --> SDK2

    style P fill:#93c5fd
    style PR fill:#ddd6fe
    style CSDK fill:#fcd34d
    style CXSDK fill:#86efac
```

## Comparison: Direct SDK vs Protocol Pattern

### ClaudeCodeProvider (Current - Direct SDK)
- ✅ Full control over SDK features
- ✅ Easy to implement SDK-specific features (interruption, teammates)
- ❌ Tightly coupled to SDK
- ❌ Large provider size (3,612 lines)
- ❌ Hard to test without real SDK

### CodexProvider (Protocol Pattern)
- ✅ Testable with mock protocol
- ✅ Small provider size (607 lines)
- ✅ Clean separation of concerns
- ❌ Protocol layer adds abstraction overhead
- ❌ May not expose all SDK features

## Recommended: Hybrid Approach
- Keep ClaudeCodeProvider with direct SDK access (unique features need it)
- Extract reusable services (MCP config, permissions, hooks)
- CodexProvider can use protocol OR direct SDK based on needs
- Focus on service extraction, not forced protocol abstraction
