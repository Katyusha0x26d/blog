---
title: 算能边缘计算设备开发环境的搭建指北
categories: 嵌入式
tags:
    - 模型部署
    - 嵌入式
    - 深度学习
---

[算能（Sophgo）](https://www.sophgo.com/about-us/index.html)是国内开发边缘计算处理器比较著名的公司

参加的一次竞赛，在使用其`cv181x`处理器部署深度学习模型时，因为开发环境[`cviruntime`](https://github.com/sophgo/cviruntime)的官方文档不是很完整，所以在开发环境的搭建上折腾了一小段时间，随后便写下此文记录我个人的解决方案，以供查阅

<!-- more -->

## 安装WSL2

:::tip

对于在Windows 11上已经安装了VMware Workstation Pro虚拟机以及搭建好了Linux开发环境的读者，可以跳过该章节

:::

应用开发使用C++和`cviruntime`、`OpenCV`进行**交叉编译**，因此需要配置一个适合用于交叉编译的环境，我推荐习惯Windows的读者使用[`Windows Subsystem for Linux`](https://learn.microsoft.com/zh-cn/windows/wsl/)

### 先决条件

请在`控制面板->程序->启用或关闭Windows功能`里，启用`Hyper-V`、`Virtual Machine Platform`、`Windows虚拟机监控程序平台`、`适用于Linux的Windows子系统`，随后重启

### 安装Ubuntu WSL2

在Windows 11及更新的系统上，使用如下指令安装WSL2：

```shell
wsl --install -d Ubuntu
```

安装完成后将会提示你创建用户以及输入用户登录密码

::: tip

如果提示你升级WSL内核，请前往[下载 Linux 内核更新包 - Microsoft Learn](https://learn.microsoft.com/zh-cn/windows/wsl/install-manual#step-4---download-the-linux-kernel-update-package)安装更新包并重新安装Ubuntu WSL

:::

### 可选-将WSL移动到其它驱动器

WSL默认安装于C盘，如果你的C盘空间不够或者你有*极强的文件约束习惯*，可以使用以下操作将已安装的WSL移动到其它驱动器（请将我的目录地址以及用户名等修改为你的实际值）：

备份原有的WSL操作系统：

```shell
wsl --export Ubuntu D:\Archives\ubuntu-wsl-initial.tar
```

卸载已安装的WSL：

```shell
wsl --unregister Ubuntu
```

将WSL安装到其它驱动器的新位置：

```shell
wsl --import Ubuntu D:\VirtualMachines\WSL\Ubuntu D:\Archives\ubuntu-wsl-initial.tar
```

配置wsl默认用户：

```shell
wsl --manage Ubuntu --set-default-user maxwell
```

（可选）配置wsl命令默认指代的实例，如果你同时安装了Docker Desktop，或者其他的WSL实例，请执行以下操作：

```shell
wsl --set-default Ubuntu
```

## 安装Docker

Docker基于Linux命名空间实现资源隔离，因此可以很方便地在一个操作系统内部署多个不同的应用环境而互相不受影响

在Windows上安装Docker即在Windows上的Linux环境里安装Docker，读者可以选择在VMware Workstation Pro的Linux虚拟机里安装，也可以选择直接使用Docker Desktop

Docker Desktop使用WSL2提供的Linux环境，因此若想使用Docker Desktop需要预先确保Hyper-V以及WSL2已经被正确安装

随后转到[Docker Desktop的官方网站](https://www.docker.com/products/docker-desktop/)下载并安装Docker Desktop

![安装好的Docker Desktop](https://lc-gluttony.s3.amazonaws.com/6Beck3SuJkGW/cxbt0vPW8MDJFwnSBJhXaCU4T4yARs1t/Snipaste_2025-04-24_19-10-58.png "安装好的Docker Desktop")

## 配置vscode

建议使用Microsoft VS Code作为你的编辑器，如果没有，请前往[官网](https://code.visualstudio.com/)下载并安装

### 安装插件

对于C++开发建议使用clangd提供自动补全以及错误检查，为此你需要安装clangd插件。连接远程Linux系统需要使用SSH，因此你需要安装Remote Development捆绑插件

## 搭建基本Linux开发环境

使用以下指令连接上安装好的Ubuntu WSL：

```shell
wsl -d Ubuntu --cd ~
```

![进入WSL示例](https://lc-gluttony.s3.amazonaws.com/6Beck3SuJkGW/WJrG6XETXaqmgkCbvi8MFVP01xArogaW/Snipaste_2025-04-24_13-08-04.png "进入WSL示例")

### 更换软件源

在Ubuntu上，更换APT软件源，如果你想使用[清华大学开源软件镜像站](https://mirrors.tuna.tsinghua.edu.cn/)，请转到[他们的帮助页面](https://mirrors.tuna.tsinghua.edu.cn/help/ubuntu/)查看如何更换软件源

补一张换源后的`/etc/apt/sources.list.d/ubuntu.sources`

![ubuntu.sources示例](https://lc-gluttony.s3.amazonaws.com/6Beck3SuJkGW/xDLAi18VEoHk8NaPGc2t6aHeHnWFQEyv/Snipaste_2025-04-24_13-10-12.png "ubuntu.sources示例")

### 安装基本软件

使用以下命令安装基本环境：

```shell
sudo apt install gcc g++ git cmake ninja-build python3 python3-pip clangd
```

### 安装交叉编译工具链

算能cv181x具有两个架构的处理器：ARM和Risc-V

`git clone` 算能Risc-V工具链的编译后二进制仓库：

```shell
git clone https://github.com/sophgo/host-tools.git sophgo-toolchain
```

::: warning

对于Risc-V，**此处**我们要使用的是`musl libc`而不是`glibc`，有关二者区别，请参考：

[1.glibc和musl libc的区别](https://www.cnblogs.com/youxin/p/17818574.html)

[2.Functional differences from glibc](https://wiki.musl-libc.org/functional-differences-from-glibc.html)

:::

获取工具链后此时我们并不能直接通过`riscv64-unknown-linux-musl-gcc`调用编译器，而是应该指定编译器程序的路径或者配置环境变量（实际上不建议配置环境变量给这种小公司小项目，以免扰乱系统原本的环境变量设置）

::: info

对于算能这样的***国产、小公司、小项目***的正确态度应该是每一次使用他们的产品都将是人生自此之后最后一次使用，毕竟这种公司能不能活到我三十五岁退休都不一定

:::

切换到编译器路径，运行编译器查看输出是否正确

```shell
cd sophgo-toolchain/gcc/riscv64-linux-musl-x86_64/bin/
./riscv64-unknown-linux-musl-gcc -v
```

没有问题的情况下会有如下图所示的输出结果

![交叉编译器正常输出](https://lc-gluttony.s3.amazonaws.com/6Beck3SuJkGW/2kBvX0EM0jRMt0OPxux9A3X3BjkjDFyh/Snipaste_2025-04-25_19-48-21.png "交叉编译器的正常输出")

## 搭建cviruntime环境

在算能设备上推理模型需要使用`cviruntime`调用其TPU，起初我使用Sophgo维护的`cviruntime`和`cvikernel`，结果因为该项目文档极少且**错误较多**屡次编译失败，最后找到了milkv-duo维护的`sg200x-tpu-sdk`，遂改为使用该SDK开发

### 克隆TPU-SDK仓库

切换到工作目录`git clone` SDK仓库

```shell
git clone https://github.com/milkv-duo/tpu-sdk-sg200x.git tpu-sdk
```

### 搭建模型开发环境

安装PyTorch、Jetbrains PyCharm，此处略过

### 搭建模型转换环境

在Docker Desktop里拉取`sophgo/tpuc_dev:latest`镜像

打开powershell使用下述命令启动容器：

```shell
 docker run --name tpuc_dev -v /workspace -it sophgo/tpuc_dev:latest
```

::: warning

milkv-duo的文档启动时具有一个参数`--privileged`，因为处于特权模式下的容器root用户具有与宿主机root用户相同的权限，我建议去掉该参数以保证安全性，关于利用Docker特权模式进行容器逃逸，请见[记一次Docker下的Privileged特权模式容器逃逸](https://www.isisy.com/1510.html)

:::

对于已经启动的容器，可以登录上去：

```shell
docker exec -it tpuc_dev /bin/bash
```

在工作目录`git clone` 转换工具仓库

```shell
git clone https://github.com/milkv-duo/tpu-mlir.git
```

## 测试环境

我们将在设备上部署[Facebook Research](https://ai.meta.com/research/)的[`DinoV2特征提取器`](https://arxiv.org/pdf/2304.07193)测试环境搭建是否正确

### 获取onnx模型

通过torch加载位于TorchHub的预训练模型，查看模型的详细信息并导出为onnx格式

```python
import torch
import torchinfo

dinov2_vits14 = torch.hub.load('facebookresearch/dinov2', 'dinov2_vits14', pretrained=True)
torchinfo.summary(dinov2_vits14, (1, 3, 448, 448))
```


```
==========================================================================================
Layer (type:depth-idx)                   Output Shape              Param #
==========================================================================================
DinoVisionTransformer                    [1, 384]                  526,848
├─PatchEmbed: 1-1                        [1, 1024, 384]            226,176
├─ModuleList: 1-2                        --                        21,302,784
├─LayerNorm: 1-3                         [1, 1025, 384]            768
├─Identity: 1-4                          [1, 384]                  --
==========================================================================================
Total params: 22,056,576
Trainable params: 22,056,576
Non-trainable params: 0
Total mult-adds (Units.MEGABYTES): 252.90
==========================================================================================
Input size (MB): 2.41
Forward/backward pass size (MB): 497.51
Params size (MB): 86.12
Estimated Total Size (MB): 586.03
==========================================================================================
```

::: error

如果仅仅将上述获得的模型导出为onnx格式，那么由于模型`forward`函数具有额外的除了张量以外的参数，会导致后续处理onnx模型时存在问题，因此我们需要对原有模型进行包装

:::


```python
import torch
import torch.nn as nn

class WrappedModel(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, x):
        return self.model(x)

test_inputs = torch.randn(1, 3, 448, 448)
model = WrappedModel(dinov2_vits14)

torch.onnx.export(model, test_inputs, dynamo=False, f='dinov2_vits14.onnx', external_data=False)
```

导出后onnx模型即为`dinov2_vits14.onnx`

::: tip

如果提示torch缺失依赖库`onnx`、`onnxruntime`，安装即可

:::

::: tip

如果在安装onnx时，安装失败，出现子命令执行错误，以及cmake的运行错误提示，这可能是因为你的Python版本过高，onnx暂时没有为你的Python版本发布的二进制已编译的发行版，因此onnx在安装时会尝试从源码开始构建，那么此时如果你缺失了`ProtoBuf`等依赖库，就会编译错误

最为简单的解决方案是将Python降级一个版本，例如在我写这篇文章时，是2025年四月，我的环境使用的是`Python 3.13.3`，而onnx最高只有`Python 3.12`的已编译的发行版，此时就出现了这个错误，将Python降级为3.12.10即可解决该错误

:::

::: tip

如果你在安装onnx时，又出现了`文件名或扩展名太长`错误，这是因为Windows系统对于文件路径最长限制在260个字符，这可以在Windows 10/11上通过修改注册表键`HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled`，将键值设置为1解决，具体请参考[最大路径长度限制-Microsoft文档](https://learn.microsoft.com/zh-cn/windows/win32/fileio/maximum-file-path-limitation?tabs=registry)

:::

### 将onnx模型转换为cvimodel

进入转换工具的Docker环境，设置环境变量

```shell
source tpu-mlir/envsetup.sh
mkdir dinov2 && cd dinov2
```

获取一部分图片用于生成校准数据，读者可以自行按照部署环境情况获取图片，也可以使用现有数据集，例如`ImageNet-1k`等

将onnx模型上传到Docker容器

```shell
docker cp dinov2_vits14.onnx tpuc_dev:/workspace/dinov2/dinov2_vits14.onnx
```

利用`model_transform.py`将模型转换为`mlir`格式

```shell
model_transform.py \
--model_name dinov2_vits14 \
--model_def dinov2_vits14.onnx \
--input_shapes [[1,3,448,448]] \
--pixel_format "rgb" \
--keep_aspect_ratio \
--mean 123.675,116.28,103.53 \
--scale 0.0171,0.0175,0.0174 \
--mlir dinov2_vits14.mlir \
```
使用`run_calibration.py`生成校准表

```shell
run_calibration.py dinov2_vits14.mlir \
--dataset imagenet \
--input_num 100 \
-o dinov2_vits14_calib_table
```

将MLIR量化成INT8非对称cvimodel：

```shell
model_deploy.py \
--mlir dinov2_vits14.mlir \
--asymmetric \
--calibration_table dinov2_vits14_calib_table \
--chip cv181x \
--quantize INT8 \
--model dinov2_vits14.cvimodel
```

### 编写cvimodel推理程序

在之前安装的Ubuntu WSL上创建项目文件夹，配置clangd插件，配置项目

```shell
mkdir guidance && cd guidance
mkdir build
mkdir .vscode && touch .vscode/settings.json
touch CMakeLists.txt
touch main.cpp
touch .clangd
```

编辑下列文件：

::: code-group

```json [.vscode/settings.json]
{
    "clangd.arguments": [
        "--log=verbose",
        "--background-index",
        "--compile-commands-dir=build",
        "-j=12",
        "--clang-tidy",
        "--all-scopes-completion",
        "--header-insertion=never",
        "--completion-style=detailed",
        "--function-arg-placeholders",
        "--pch-storage=memory",
        "--fallback-style=LLVM",
        "--suggest-missing-includes",
    ]
}
```

```yaml [.clangd]
CompileFlags:
    Remove: 
        - "-march=*"
        - "-mcpu=*"
```

```cmake [CMakeLists.txt]
cmake_minimum_required(VERSION 3.25)
project(guidance CXX)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_C_STANDARD 11)

set(TPU_SDK_PATH /home/maxwell/tpu-sdk)
set(HOST_TOOLS_PATH /home/maxwell/sophgo-toolchain)

include(CMakeForceCompiler)

set(CMAKE_SYSTEM_NAME          Linux)
set(CMAKE_SYSTEM_PROCESSOR     riscv)
set(ARCH riscv)
set(CROSS_COMPILE ${HOST_TOOLS_PATH}/gcc/riscv64-linux-musl-x86_64/bin/riscv64-unknown-linux-musl-)

set(CMAKE_C_COMPILER ${CROSS_COMPILE}gcc)
set(CMAKE_CXX_COMPILER ${CROSS_COMPILE}g++)

message(STATUS "CMAKE_C_COMPILER: ${CMAKE_C_COMPILER}")
message(STATUS "CMAKE_CXX_COMPILER: ${CMAKE_CXX_COMPILER}")

set(CMAKE_OBJCOPY ${CROSS_COMPILE}objcopy
	    CACHE FILEPATH "The toolchain objcopy command " FORCE )

set(CMAKE_SYSROOT ${HOST_TOOLS_PATH}/gcc/riscv64-linux-musl-x86_64/sysroot)

set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS}" CACHE STRING "")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS}" CACHE STRING "")
set(CMAKE_ASM_FLAGS "${CMAKE_C_FLAGS}" CACHE STRING "")

set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -mcpu=c906fdv")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -mcpu=c906fdv")
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -march=rv64gcv0p7_zfh_xthead -mabi=lp64d")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -march=rv64gcv0p7_zfh_xthead -mabi=lp64d")

set(CMAKE_BUILD_TYPE RELEASE)
set(CMAKE_CXX_FLAGS_RELEASE -O3)
set(CMAKE_C_FLAGS_RELEASE -O3)

include_directories(
    ${TPU_SDK_PATH}/include
    ${TPU_SDK_PATH}/flatbuffers/include
    ${TPU_SDK_PATH}/opencv/include
)

add_executable(guidance main.cpp)

link_libraries(
    ${TPU_SDK_PATH}/lib
    ${TPU_SDK_PATH}/flatbuffers/lib
    ${TPU_SDK_PATH}/opencv/lib
)

target_link_libraries(guidance
    ${TPU_SDK_PATH}/lib/libcviruntime.so
    ${TPU_SDK_PATH}/opencv/lib/libopencv_core.so
    ${TPU_SDK_PATH}/opencv/lib/libopencv_imgproc.so
    ${TPU_SDK_PATH}/opencv/lib/libopencv_imgcodecs.so
)
```

```c++ [main.cpp]
#include <iostream>
#include <fstream>
#include <cviruntime.h>
#include <opencv2/opencv.hpp>
#include <numeric>

#define IMG_RESIZE_DIMS 448,448
#define BGR_MEAN        123.675,116.28,103.53
#define INPUT_SCALE     0.0171,0.0175,0.0174

void usage() {
    printf("Usage: dinov2 <model> <image> <labels_file>\n");
}

int main(int argc, char **argv) {
    if (argc < 3) {
        usage();
    }
    const char *model_path = argv[1];
    const char *image_path = argv[2];
    const char *labels_path = argv[3];
    // load model
    CVI_MODEL_HANDLE model = nullptr;
    int rc = CVI_NN_RegisterModel(model_path, &model);
    if (rc != CVI_RC_SUCCESS) {
        printf("CVI_NN_RegisterModel failed, err %d\n", rc);
        return 1;
    }
    CVI_TENSOR *input_tensors, *output_tensors;
    int32_t input_num, output_num;
    CVI_NN_GetInputOutputTensors(model, &input_tensors, &input_num, &output_tensors, &output_num);
    CVI_TENSOR *input = CVI_NN_GetTensorByName(CVI_NN_DEFAULT_TENSOR, input_tensors, input_num);
    CVI_TENSOR *output = CVI_NN_GetTensorByName(CVI_NN_DEFAULT_TENSOR, output_tensors, output_num);
    float qscale = CVI_NN_TensorQuantScale(input);
    printf("qscale: %f\n", qscale);
    CVI_SHAPE shape = CVI_NN_TensorShape(input);
    int32_t height = shape.dim[2];
    int32_t width = shape.dim[3];
    // Load input image
    cv::Mat image = cv::imread(image_path);
    if (!image.data) {
        printf("Could not open image\n");
        return 1;
    }
    cv::resize(image, image, cv::Size(IMG_RESIZE_DIMS));
    cv::Size size = cv::Size(height, width);
    cv::Mat channels[3];
    for (int i = 0; i < 3; i++) {
        // CV_8SC1: 8 bit signed  single channel matrix
        channels[i]  = cv::Mat(height, width, CV_8SC1);
    }
    cv::split(image, channels);
    float mean[]  = {BGR_MEAN};
    float input_scale[] = {INPUT_SCALE};
    for (int i = 0; i < 3; i++) {
        channels[i].convertTo(channels[i], CV_8SC1, input_scale[i] * qscale, -1 * mean[i] * input_scale[i] * qscale);
    }
    // input image to model
    int8_t *ptr = (int8_t *)CVI_NN_TensorPtr(input);
    int channel_size = height * width;
    for (int i = 0; i < 3; i++) {
        memcpy(ptr + i * channel_size, channels[i].data, channel_size);
    }
    // run inference
    CVI_NN_Forward(model,  input_tensors, input_num, output_tensors, output_num);
    printf("CVI_NN_Forward succeeded.\n");
    // output result
    std::vector<std::string> labels;
    std::ifstream labels_file(labels_path);
    if (!labels_file) {
        printf("Unable to load labels file.\n");
        return 1;
    }
    std::string line;
    while (std::getline(labels_file, line)) {
        labels.push_back(std::string(line));
    }
    int32_t top_num = 5;
    float *probabilities = (float *)CVI_NN_TensorPtr(output);
    int32_t count = CVI_NN_TensorCount(output);
    std::vector<size_t> idx(count);
    std::iota(idx.begin(), idx.end(), 0);
    std::sort(idx.begin(), idx.end(), [&probabilities](size_t idx_0, size_t idx_1){
        return probabilities[idx_0] > probabilities[idx_1];
    });
    printf("----------\n");
    printf("Label\tProbability\n");
    for (size_t i = 0; i < top_num; i++) {
        int top_k_idx = idx[i];
        if (!labels.empty()) {
            printf("%s\t%.5f\n", labels[top_k_idx].c_str(), probabilities[top_k_idx]);
        } else {
            printf("%d\t%.5f\n", top_k_idx, probabilities[top_k_idx]);
        }
    }
    printf("----------\n");
    // cleanup
    CVI_NN_CleanupModel(model);
    printf("CVI_NN_CleanupModel succeeded\n");
    return 0;
}
```

:::

随后执行cmake配置，可以使用vscode自动配置也可以进入build目录手动配置

随后打开`main.cpp`可以看到clangd已经没有报错了，按住CTRL左键点击任何函数也能跳转到定义

切换到`build`目录，执行`ninja`或者使用cmake插件自动编译也可以

生成了`guidance`这个可执行文件，我们使用SCP将其以及cvimodel模型、测试图片传输到设备上

```shell
scp -O .\dinov2_vits14.cvimodel root@192.168.42.1:/root/dinov2_vits14.cvimodel
```

### 设备上的测试结果

![测试结果](https://lc-gluttony.s3.amazonaws.com/6Beck3SuJkGW/HcCWi93QM28eJniJlO4DzHzEzmCrUpQP/Snipaste_2025-04-25_23-30-04.png "测试结果")