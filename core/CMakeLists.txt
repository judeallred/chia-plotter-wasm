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

# Patched copies of a few upstream headers, generated into build/gen at configure time.
# Each edit must match exactly once, so an upstream change fails the build loudly instead
# of silently dropping a patch.
set(GEN_DIR ${CMAKE_CURRENT_BINARY_DIR}/gen)
# One edit per call. Arguments are passed separately because CMake lists would split C++
# code on its semicolons.
function(pos2w_edit var old new)
  string(FIND "${${var}}" "${old}" pos)
  if(pos EQUAL -1)
    message(FATAL_ERROR "Upstream changed: cannot find \"${old}\". Update core/CMakeLists.txt.")
  endif()
  string(REPLACE "${old}" "${new}" result "${${var}}")
  set(${var} "${result}" PARENT_SCOPE)
endfunction()

# Plotter.hpp: upstream copies the final proof fragments into PlotData instead of moving
# them, which costs 2 GB of peak memory at k28 and decides whether k28 fits in a tab. Also
# swap in the Xs constructor that can run g(x) on the GPU.
# plot/ and solve/ are copied whole. Their headers include each other by relative path, so
# a patched header is only used consistently if its neighbours come from gen/ too.
file(COPY ${POS2_DIR}/src/plot ${POS2_DIR}/src/solve DESTINATION ${GEN_DIR})

# TableConstructorGeneric.hpp: try the GPU for the matching target hash before the CPU loop.
file(READ ${GEN_DIR}/plot/TableConstructorGeneric.hpp tcg_src)
pos2w_edit(tcg_src "#include \"pos/ProofValidator.hpp\"" "#include \"pos/ProofValidator.hpp\"\n#include \"table_gpu.hpp\"")
pos2w_edit(tcg_src
  "parallel_for_range(uint64_t(0),\n                    uint64_t(l_count),"
  "std::size_t const pos2w_done = pos2w::gpu_match_targets(params_, int(table_id_), previous_table_pairs.data() + l_start, l_ptr, l_count, match_key_r);\n                parallel_for_range(uint64_t(pos2w_done),\n                    uint64_t(l_count),")
file(WRITE ${GEN_DIR}/plot/TableConstructorGeneric.hpp "${tcg_src}")

file(READ ${GEN_DIR}/plot/Plotter.hpp plotter_src)
pos2w_edit(plotter_src
  "plot_data.t3_proof_fragments = t3_proof_fragments;"
  "plot_data.t3_proof_fragments = std::move(t3_proof_fragments);")
pos2w_edit(plotter_src "#include \"common/Timer.hpp\"" "#include \"common/Timer.hpp\"\n#include \"xs_gpu.hpp\"")
pos2w_edit(plotter_src
  "XsConstructor xs_gen_ctor(proof_params_, sink);"
  "pos2w::GpuXsConstructor xs_gen_ctor(proof_params_, sink);")
# Record each table's phase timings (hash, sort, find pairs, post sort) for the UI.
foreach(t 1 2 3)
  if(t EQUAL 3)
    set(var t3_results)
  else()
    set(var t${t}_pairs)
  endif()
  pos2w_edit(plotter_src "auto ${var} = t${t}_ctor.construct(" "pos2w::PhaseRecorder t${t}_recorder(${t}, t${t}_ctor.timings);\n        auto ${var} = t${t}_ctor.construct(")
endforeach()
option(POS2W_DEV_TIMINGS "Print upstream's per phase plotter timings" OFF)
if(POS2W_DEV_TIMINGS)
  pos2w_edit(plotter_src "#define DEVELOPER_PERFORMANCE_TIMINGS 0" "#define DEVELOPER_PERFORMANCE_TIMINGS 1")
endif()
file(WRITE ${GEN_DIR}/plot/Plotter.hpp "${plotter_src}")

# Solver.hpp: route the all-x g(x) bitmask pass through the GPU when one is attached.
file(READ ${GEN_DIR}/solve/Solver.hpp solver_src)
file(READ ${CMAKE_CURRENT_SOURCE_DIR}/src/solver_gpu_inject.inc solver_inject)
pos2w_edit(solver_src "#include \"common/Timer.hpp\"" "#include \"common/Timer.hpp\"\n#include \"gpu_bridge.hpp\"")
pos2w_edit(solver_src
  "    void filterX2Candidates(std::span<uint32_t const> const x1_bitmask,"
  "${solver_inject}    void filterX2Candidates_cpu(std::span<uint32_t const> const x1_bitmask,")
file(WRITE ${GEN_DIR}/solve/Solver.hpp "${solver_src}")

set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
  ${POS2_DIR}/src/plot/Plotter.hpp ${POS2_DIR}/src/solve/Solver.hpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/solver_gpu_inject.inc
  ${POS2_DIR}/src/plot/TableConstructorGeneric.hpp)

add_library(pos2w_core INTERFACE)
# Search order matters: gen/ and overrides/ shadow upstream files.
target_include_directories(pos2w_core INTERFACE
  ${GEN_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/overrides ${CMAKE_CURRENT_SOURCE_DIR}/src ${POS2_DIR}/src)
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
