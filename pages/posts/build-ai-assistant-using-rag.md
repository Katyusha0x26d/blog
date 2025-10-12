---
title: 利用RAG低成本构建一个专业AI助手
categories: AI
tags:
    - LLM
    - RAG
date: 2025-09-05 22:45:00 +0800
updated: 2025-09-05 22:45:00 +0800
---

最近想做一个医学知识库（类似于默沙东诊疗手册，但是更加全面智能），患者可以通过询问自己的症状，得出初步的诊疗意见，问题是，这些知识都不在模型的训练数据里

直接fine-tune？成本太高，而且每次更新知识都要重新训练。后来想到了RAG方案

<!-- more -->

## RAG解决了什么问题？

大语言模型（LLM）虽然强大，但有几个天然的限制：

### 知识截止日期

GPT-4的训练数据截止到2023年4月，你问它"2024年巴黎奥运会谁拿了金牌"，它只能说"我不知道"。即使知道，也可能是训练数据中的错误信息

### 领域知识不足

通用模型对专业领域的知识覆盖有限。比如：
- 你公司的内部文档
- 最新的医学研究论文
- 特定行业的法规政策

### 幻觉问题（Hallucination）

当模型不确定答案时，它不会说"我不知道"，而是编造一个听起来很合理的错误答案。这在专业场景下是致命的

**RAG的思路很直接**：既然模型不知道，那就先查资料，再基于资料回答

## RAG的工作原理

RAG的核心流程可以分为两个阶段：索引构建和检索生成

### 索引构建阶段

这个阶段是离线完成的，把知识库转换成模型可以检索的格式：

```
原始文档 → 文本分块 → 向量化 → 存入向量数据库
```

**1. 文本分块（Chunking）**

长文档需要切分成小块，原因有几个：
- Embedding模型有最大输入长度限制（通常512-8192 tokens）
- 小块的语义更聚焦，检索更精准
- 生成时上下文长度有限，不能把整本书都塞进去

常见的分块策略：

```python
# 固定长度分块
def chunk_by_size(text, chunk_size=500, overlap=50):
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end]
        chunks.append(chunk)
        start = end - overlap  # 重叠部分避免语义割裂
    return chunks

# 按语义单元分块（更智能）
def chunk_by_semantic(text):
    # 按段落、章节、句子等自然边界切分
    paragraphs = text.split('\n\n')
    return [p for p in paragraphs if len(p.strip()) > 50]
```

分块大小的选择是个权衡：
- **太小**（<200字符）：语义不完整，检索准召率低
- **太大**（>2000字符）：噪音太多，相关信息被稀释

我的经验是500-1000字符比较合适，具体看领域特点

**2. 向量化（Embedding）**

把文本转换成高维向量（通常768维或1536维），语义相似的文本在向量空间中距离更近

```python
from sentence_transformers import SentenceTransformer

# 使用开源的Embedding模型
model = SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')

chunks = [
    "糖尿病是一种代谢性疾病，特征是血糖水平持续升高",
    "高血压是指动脉血压持续高于正常范围",
    "Python是一种高级编程语言"
]

embeddings = model.encode(chunks)
print(embeddings.shape)  # (3, 384)
```

常用的Embedding模型：

| 模型 | 维度 | 特点 |
|-----|------|------|
| text-embedding-ada-002 | 1536 | OpenAI的商业模型，效果好但收费 |
| all-MiniLM-L6-v2 | 384 | 开源，速度快，适合中文+英文 |
| m3e-base | 768 | 针对中文优化 |
| bge-large-zh | 1024 | 中文效果最好的开源模型之一 |

:::tip

选择Embedding模型时注意：
- 语言支持（中文模型效果比通用模型好）
- 向量维度（维度高精度好但存储和计算成本高）
- 最大输入长度（决定了chunk大小）

:::

**3. 存储到向量数据库**

向量数据库支持高效的相似度检索，常见的有：

- **Faiss**：Meta开源，纯向量检索，性能极强
- **Milvus**：云原生，支持分布式部署
- **Chroma**：轻量级，适合快速原型
- **Qdrant**：支持混合检索（向量+关键词）

```python
import chromadb

# 初始化Chroma客户端
client = chromadb.Client()
collection = client.create_collection(name="knowledge_base")

# 添加文档
collection.add(
    documents=chunks,
    embeddings=embeddings.tolist(),
    metadatas=[{"source": "medical_handbook.pdf", "page": i} for i in range(len(chunks))],
    ids=[f"doc_{i}" for i in range(len(chunks))]
)
```

### 检索生成阶段

用户提问时的实时流程：

```
用户问题 → 向量化 → 检索Top-K文档 → 构造Prompt → LLM生成答案
```

**1. 向量检索**

把问题用同样的Embedding模型转换成向量，然后在向量数据库中找最相似的K个文档：

```python
def retrieve(query, top_k=3):
    # 问题向量化
    query_embedding = model.encode([query])[0]

    # 检索最相似的文档
    results = collection.query(
        query_embeddings=[query_embedding.tolist()],
        n_results=top_k
    )

    return results['documents'][0], results['metadatas'][0]
```

相似度计算通常用**余弦相似度**或**欧氏距离**：

$$
\text{cosine similarity} = \frac{\vec{A} \cdot \vec{B}}{|\vec{A}| \cdot |\vec{B}|}
$$

**2. Prompt工程**

把检索到的文档和用户问题组合成Prompt：

```python
def generate_answer(query, contexts):
    prompt = f"""你是一个专业的医疗助手。请基于以下参考资料回答用户的问题。

参考资料：
{chr(10).join(f"[{i+1}] {ctx}" for i, ctx in enumerate(contexts))}

用户问题：{query}

回答要求：
1. 仅基于参考资料回答，不要编造信息
2. 如果参考资料不足以回答问题，请明确说明
3. 引用参考资料时标注来源编号

回答："""

    response = llm.generate(prompt)
    return response
```

这个Prompt设计有几个关键点：
- **明确角色**：告诉模型它是什么身份
- **提供上下文**：把检索到的文档放在显眼位置
- **约束行为**：要求基于资料回答，减少幻觉
- **引导格式**：要求标注来源，方便验证

## RAG的核心挑战

理论简单，但实际部署时会遇到很多问题

### 检索质量不稳定

**问题1：语义鸿沟**

用户问"怎么退货"，文档里写的是"退换货政策"，关键词不匹配导致检索失败

解决方案：
- 使用更好的Embedding模型（如bge-large-zh）
- Query改写：先让LLM把问题扩展成多个相关查询
- 混合检索：结合BM25关键词检索和向量检索

```python
def hybrid_search(query, top_k=5):
    # 向量检索
    vector_results = vector_search(query, top_k * 2)

    # BM25关键词检索
    bm25_results = bm25_search(query, top_k * 2)

    # 融合排序（RRF算法）
    merged = reciprocal_rank_fusion([vector_results, bm25_results])
    return merged[:top_k]
```

**问题2：噪音文档**

检索到的Top-K文档中有不相关的内容，干扰模型生成

解决方案：
- 设置相似度阈值（如cosine similarity < 0.7就过滤）
- Reranking：用专门的重排序模型对检索结果二次打分

```python
from sentence_transformers import CrossEncoder

reranker = CrossEncoder('cross-encoder/ms-marco-MiniLM-L-6-v2')

def rerank(query, candidates):
    pairs = [(query, doc) for doc in candidates]
    scores = reranker.predict(pairs)

    # 按分数排序并过滤低分文档
    ranked = [(doc, score) for doc, score in zip(candidates, scores) if score > 0.5]
    ranked.sort(key=lambda x: x[1], reverse=True)
    return [doc for doc, _ in ranked]
```

### 上下文长度限制

检索到很多相关文档，但都塞进Prompt会超过模型的上下文窗口（如GPT-3.5的4K tokens）

解决方案：
- **文档压缩**：让LLM先提取每个文档的核心信息
- **层次检索**：先粗筛一批文档，再从中精选最相关的
- **长文本模型**：使用支持更长上下文的模型（如GPT-4-turbo的128K）

```python
def compress_documents(query, docs):
    compressed = []
    for doc in docs:
        prompt = f"提取以下文档中与问题「{query}」相关的核心信息：\n{doc}"
        summary = llm.generate(prompt, max_tokens=200)
        compressed.append(summary)
    return compressed
```

### 多跳推理问题

有些问题需要综合多个文档的信息：

> 问：糖尿病患者能不能吃降压药A？

需要的知识：
1. 文档1：糖尿病患者的用药禁忌
2. 文档2：降压药A的成分和副作用
3. 文档3：两者的药物相互作用

普通RAG很难处理这种复杂推理

解决方案：
- **迭代检索**：根据初步答案再次检索补充信息
- **HyDE**（Hypothetical Document Embeddings）：先让模型生成假设答案，用假设答案检索
- **Graph RAG**：构建知识图谱，支持多跳推理

## RAG的进阶优化

### Self-RAG：让模型自己决定何时检索

标准RAG对每个问题都检索，但有些问题（如"1+1等于几"）根本不需要外部知识

Self-RAG的思路：训练一个小模型判断是否需要检索，以及检索结果是否可信

```
用户问题 → 判断是否需要检索
              ↓ 需要
           向量检索 → 判断检索结果质量
              ↓ 质量好
           基于检索结果生成 → 判断答案置信度
              ↓ 置信度低
           重新检索或生成
```

### RAG-Fusion：多查询融合

把一个问题扩展成多个角度的查询，分别检索后融合结果：

```python
def rag_fusion(original_query):
    # 1. 生成多个相关查询
    expansion_prompt = f"针对问题「{original_query}」，生成3个不同角度的相关查询："
    related_queries = llm.generate(expansion_prompt).split('\n')

    # 2. 每个查询独立检索
    all_results = []
    for query in related_queries:
        results = retrieve(query, top_k=5)
        all_results.append(results)

    # 3. 融合排序
    final_docs = reciprocal_rank_fusion(all_results)
    return final_docs[:5]
```

### 引用验证

生成答案后，验证每句话是否有检索文档支持：

```python
def verify_answer(answer, sources):
    sentences = answer.split('。')
    verified = []

    for sent in sentences:
        prompt = f"句子「{sent}」是否被以下任一资料支持？\n{sources}\n只回答：是/否"
        is_supported = llm.generate(prompt).strip()

        if is_supported == "是":
            verified.append(sent)
        else:
            verified.append(f"[未验证] {sent}")

    return '。'.join(verified)
```

## 实现一个完整的RAG系统

把上面的技术组合起来，实现一个生产级的RAG系统：

```python
import chromadb
from sentence_transformers import SentenceTransformer, CrossEncoder
from openai import OpenAI

class RAGSystem:
    def __init__(self):
        self.embedder = SentenceTransformer('moka-ai/m3e-base')
        self.reranker = CrossEncoder('BAAI/bge-reranker-large')
        self.llm = OpenAI(api_key="your-key")

        self.chroma_client = chromadb.Client()
        self.collection = self.chroma_client.get_or_create_collection(
            name="knowledge_base",
            metadata={"hnsw:space": "cosine"}
        )

    def index_documents(self, documents, metadatas):
        """索引文档到向量数据库"""
        chunks = []
        chunk_metas = []

        for doc, meta in zip(documents, metadatas):
            # 智能分块
            doc_chunks = self._chunk_document(doc)
            chunks.extend(doc_chunks)
            chunk_metas.extend([{**meta, 'chunk_id': i} for i in range(len(doc_chunks))])

        # 批量向量化
        embeddings = self.embedder.encode(chunks, show_progress_bar=True)

        # 存储
        self.collection.add(
            documents=chunks,
            embeddings=embeddings.tolist(),
            metadatas=chunk_metas,
            ids=[f"doc_{i}" for i in range(len(chunks))]
        )

        print(f"已索引 {len(chunks)} 个文档块")

    def _chunk_document(self, text, chunk_size=800, overlap=100):
        """智能文档分块"""
        # 优先按段落分
        paragraphs = text.split('\n\n')
        chunks = []
        current_chunk = ""

        for para in paragraphs:
            if len(current_chunk) + len(para) < chunk_size:
                current_chunk += para + '\n\n'
            else:
                if current_chunk:
                    chunks.append(current_chunk.strip())
                current_chunk = para + '\n\n'

        if current_chunk:
            chunks.append(current_chunk.strip())

        return chunks

    def retrieve(self, query, top_k=5):
        """检索相关文档"""
        # 1. 向量检索（召回更多候选）
        query_embedding = self.embedder.encode([query])[0]
        results = self.collection.query(
            query_embeddings=[query_embedding.tolist()],
            n_results=top_k * 3  # 召回3倍候选
        )

        candidates = results['documents'][0]
        metadatas = results['metadatas'][0]

        # 2. Rerank精排
        pairs = [[query, doc] for doc in candidates]
        scores = self.reranker.predict(pairs)

        # 3. 按分数排序并过滤
        ranked = sorted(
            zip(candidates, scores, metadatas),
            key=lambda x: x[1],
            reverse=True
        )

        # 只保留分数>阈值的结果
        filtered = [(doc, meta) for doc, score, meta in ranked if score > 0.3]

        return filtered[:top_k]

    def generate_answer(self, query, contexts):
        """基于检索结果生成答案"""
        context_str = "\n\n".join([
            f"[文档{i+1}] {doc}\n来源：{meta.get('source', '未知')}"
            for i, (doc, meta) in enumerate(contexts)
        ])

        prompt = f"""你是一个专业的知识助手。请基于以下参考资料回答用户的问题。

参考资料：
{context_str}

用户问题：{query}

回答要求：
1. 仅基于参考资料回答，引用时标注文档编号如[1]
2. 如果资料不足，明确说明"根据现有资料无法完整回答"
3. 保持专业、客观、准确

回答："""

        response = self.llm.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3
        )

        return response.choices[0].message.content

    def query(self, question, top_k=3):
        """完整的RAG查询流程"""
        print(f"问题：{question}\n")

        # 1. 检索
        contexts = self.retrieve(question, top_k)
        if not contexts:
            return "抱歉，没有找到相关资料。"

        print(f"检索到 {len(contexts)} 个相关文档片段\n")

        # 2. 生成答案
        answer = self.generate_answer(question, contexts)

        # 3. 返回结果（包含来源）
        sources = [meta.get('source', '未知') for _, meta in contexts]

        return {
            'answer': answer,
            'sources': list(set(sources)),
            'context_count': len(contexts)
        }

# 使用示例
if __name__ == "__main__":
    rag = RAGSystem()

    # 索引文档
    documents = [
        "糖尿病（Diabetes）是一种代谢性疾病，特征是血糖水平持续升高...",
        "高血压的定义是收缩压≥140 mmHg或舒张压≥90 mmHg...",
        # 更多文档...
    ]

    metadatas = [
        {"source": "医学手册.pdf", "category": "内分泌"},
        {"source": "医学手册.pdf", "category": "心血管"},
    ]

    rag.index_documents(documents, metadatas)

    # 查询
    result = rag.query("糖尿病有哪些典型症状？")
    print(f"回答：{result['answer']}\n")
    print(f"来源：{', '.join(result['sources'])}")
```

## RAG vs Fine-tuning：如何选择？

经常有人问：什么时候用RAG，什么时候用Fine-tuning？

| 维度 | RAG | Fine-tuning |
|-----|-----|-------------|
| 知识更新 | 实时（更新向量库即可） | 需要重新训练 |
| 成本 | 低（只需Embedding和向量库） | 高（需要GPU训练） |
| 响应速度 | 较慢（检索+生成） | 快（直接生成） |
| 准确性 | 高（基于真实文档） | 中（可能遗忘或混淆） |
| 可解释性 | 强（可追溯来源） | 弱（黑盒） |
| 适用场景 | 知识密集型任务 | 风格、格式适配 |

我的建议：
- **优先用RAG**：大部分知识问答场景都适合
- **结合使用**：Fine-tune一个基础模型（学会领域术语和表达风格），再用RAG注入具体知识
- **纯Fine-tuning**：只在对响应速度要求极高、知识相对固定的场景

## 写在最后

RAG本质上是把"记忆"和"推理"分离：
- **向量数据库**负责记忆（存储和检索知识）
- **大语言模型**负责推理（理解和生成回答）

这种架构很符合人类的认知模式——我们也不是把所有知识记在脑子里，而是需要时去查资料，然后基于资料思考

RAG还在快速发展，最近几个月就出现了Graph RAG、Corrective RAG、Self-RAG等新方法。但核心思想不变：让模型有据可依，减少瞎编

如果你在做知识密集型的AI应用，强烈建议试试RAG。从最简单的向量检索+Prompt开始，效果不行再逐步加入Rerank、Query改写等优化。不要一开始就搞得太复杂，先让系统跑起来
