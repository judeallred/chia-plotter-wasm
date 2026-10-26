cmake_minimum_required(VERSION 3.20)
project(pos2w LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(POS2_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/pos2-chip)

# FSE entropy coder used by chunk compression.
file(GLOB FSE_SRC ${POS2_DIR}/lib/fse/fse/*.c)
add_library(fse STATIC ${FSE_SRC})
target_include_directories(fse PUBLIC ${POS2_DIR}/lib/fse/fse)
target_compile_definitions(fse PUBLIC FSE_MAX_MEMORY_USAGE=16)

add_library(pos2w_core INTERFACE)
# overrides/ must come first so its common/thread.hpp replaces the upstream one.
target_include_directories(pos2w_core INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/overrides ${POS2_DIR}/src)
target_link_libraries(pos2w_core INTERFACE fse)

if(EMSCRIPTEN)
  option(POS2W_MEMORY64 "Build with wasm memory64 (needed for k28)" OFF)
  set(common_flags -O3 -pthread -msimd128 -fwasm-exceptions)
  if(POS2W_MEMORY64)
    list(APPEND common_flags -sMEMORY64=1)
  endif()
  target_compile_options(fse PRIVATE ${common_flags})
  target_compile_options(pos2w_core INTERFACE ${common_flags})

  if(POS2W_MEMORY64)
    set(out_name pos2w64)
    set(max_mem 16GB)
  else()
    set(out_name pos2w32)
    set(max_mem 4GB)
  endif()

  add_executable(${out_name} src/pos2w.cpp)
  target_link_libraries(${out_name} PRIVATE pos2w_core)
  target_link_options(${out_name} PRIVATE
    ${common_flags}
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createPos2w
    -sENVIRONMENT=worker,node
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=64MB
    -sMAXIMUM_MEMORY=${max_mem}
    -sSTACK_SIZE=1MB
    -sDEFAULT_PTHREAD_STACK_SIZE=1MB
    -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency+2
    -sPTHREAD_POOL_SIZE_STRICT=0
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString,wasmMemory
    -sEXPORTED_FUNCTIONS=_malloc,_free
    -sINCOMING_MODULE_JS_API=locateFile,print,printErr,onAbort,mainScriptUrlOrBlob
    -sFILESYSTEM=0
  )

  # Validator: prover, solver and validator, reading plots through the Emscripten file
  # system. WORKERFS reads File objects lazily in the browser, NODEFS is for tests.
  if(NOT POS2W_MEMORY64)
    add_executable(pos2v src/pos2v.cpp)
    target_link_libraries(pos2v PRIVATE pos2w_core)
    target_link_options(pos2v PRIVATE
      ${common_flags}
      -lworkerfs.js
      -lnodefs.js
      -sFORCE_FILESYSTEM=1
      -sMODULARIZE=1
      -sEXPORT_ES6=1
      -sEXPORT_NAME=createPos2v
      -sENVIRONMENT=worker,node
      -sALLOW_MEMORY_GROWTH=1
      -sINITIAL_MEMORY=64MB
      -sMAXIMUM_MEMORY=4GB
      -sSTACK_SIZE=1MB
      -sDEFAULT_PTHREAD_STACK_SIZE=1MB
      -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency+2
      -sPTHREAD_POOL_SIZE_STRICT=0
      -sEXPORTED_RUNTIME_METHODS=FS,WORKERFS,NODEFS,UTF8ToString,stringToUTF8,lengthBytesUTF8,wasmMemory
      -sEXPORTED_FUNCTIONS=_malloc,_free
      -sINCOMING_MODULE_JS_API=locateFile,print,printErr,onAbort,mainScriptUrlOrBlob
    )
  endif()
else()
  find_package(Threads REQUIRED)
  add_executable(pos2w_cli src/pos2w_cli.cpp)
  target_compile_options(pos2w_cli PRIVATE -O3)
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64")
    target_compile_options(pos2w_cli PRIVATE -march=armv8-a+crypto)
  endif()
  target_link_libraries(pos2w_cli PRIVATE pos2w_core Threads::Threads)
endif()
