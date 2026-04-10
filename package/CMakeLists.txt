cmake_minimum_required(VERSION 3.20)
project(bunite_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
add_compile_options("$<$<CXX_COMPILER_ID:MSVC>:/utf-8>")

if(NOT DEFINED BUNITE_TARGET_ARCH)
  set(BUNITE_TARGET_ARCH x64)
endif()

set(BUNITE_OUTPUT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/native-build/win-${BUNITE_TARGET_ARCH}")
set(BUNITE_CEF_OUTPUT_DIR "${BUNITE_OUTPUT_DIR}/cef")
file(MAKE_DIRECTORY "${BUNITE_OUTPUT_DIR}")

if(WIN32)
  if(NOT DEFINED BUNITE_CEF_ROOT)
    if(DEFINED ENV{BUNITE_CEF_ROOT})
      set(BUNITE_CEF_ROOT "$ENV{BUNITE_CEF_ROOT}")
    elseif(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/vendors/cef")
      set(BUNITE_CEF_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/vendors/cef")
    endif()
  endif()

  if(NOT BUNITE_CEF_ROOT OR NOT EXISTS "${BUNITE_CEF_ROOT}/cmake/FindCEF.cmake")
    message(FATAL_ERROR "CEF binary distribution not found.\n"
      "Set BUNITE_CEF_ROOT via cmake -D or env var, or place it at ${CMAKE_CURRENT_SOURCE_DIR}/vendors/cef.")
  endif()

  set(CEF_ROOT "${BUNITE_CEF_ROOT}")
  list(APPEND CMAKE_MODULE_PATH "${CEF_ROOT}/cmake")
  find_package(CEF REQUIRED)
  add_subdirectory("${CEF_ROOT}/libcef_dll" "${CMAKE_BINARY_DIR}/cef_wrapper")

  add_library(BuniteNative SHARED
    src/native/win/native_host_runtime.cpp
    src/native/win/native_host_utils.cpp
    src/native/win/native_host_appres.cpp
    src/native/win/native_host_cef.cpp
    src/native/win/native_host_ffi.cpp
  )
  target_include_directories(BuniteNative PRIVATE
    src/native/shared
    "${CEF_ROOT}"
    "${CEF_ROOT}/include"
  )
  target_compile_definitions(BuniteNative PRIVATE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
    _CRT_SECURE_NO_WARNINGS
    UNICODE
    _UNICODE
  )
  target_link_libraries(BuniteNative PRIVATE
    libcef_dll_wrapper
    debug "${CEF_LIB_DEBUG}"
    optimized "${CEF_LIB_RELEASE}"
    ${CEF_STANDARD_LIBS}
    user32.lib
    advapi32.lib
    shell32.lib
    ole32.lib
  )
  target_link_options(BuniteNative PRIVATE /DELAYLOAD:libcef.dll)
  set_target_properties(BuniteNative PROPERTIES
    OUTPUT_NAME "libBuniteNative"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${BUNITE_OUTPUT_DIR}"
    LIBRARY_OUTPUT_DIRECTORY_RELEASE "${BUNITE_OUTPUT_DIR}"
    ARCHIVE_OUTPUT_DIRECTORY_RELEASE "${BUNITE_OUTPUT_DIR}"
  )
  add_custom_command(TARGET BuniteNative POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${BUNITE_CEF_OUTPUT_DIR}"
    COMMAND ${CMAKE_COMMAND} -E make_directory "${BUNITE_CEF_OUTPUT_DIR}/Resources/locales"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${CEF_BINARY_DIR_RELEASE}/chrome_elf.dll"
      "${CEF_BINARY_DIR_RELEASE}/d3dcompiler_47.dll"
      "${CEF_BINARY_DIR_RELEASE}/dxcompiler.dll"
      "${CEF_BINARY_DIR_RELEASE}/dxil.dll"
      "${CEF_BINARY_DIR_RELEASE}/libcef.dll"
      "${CEF_BINARY_DIR_RELEASE}/libEGL.dll"
      "${CEF_BINARY_DIR_RELEASE}/libGLESv2.dll"
      "${CEF_BINARY_DIR_RELEASE}/v8_context_snapshot.bin"
      "${CEF_BINARY_DIR_RELEASE}/vk_swiftshader.dll"
      "${CEF_BINARY_DIR_RELEASE}/vk_swiftshader_icd.json"
      "${CEF_BINARY_DIR_RELEASE}/vulkan-1.dll"
      "${BUNITE_CEF_OUTPUT_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${CEF_RESOURCE_DIR}/chrome_100_percent.pak"
      "${CEF_RESOURCE_DIR}/chrome_200_percent.pak"
      "${CEF_RESOURCE_DIR}/icudtl.dat"
      "${CEF_RESOURCE_DIR}/resources.pak"
      "${BUNITE_CEF_OUTPUT_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
      "${CEF_RESOURCE_DIR}/locales"
      "${BUNITE_CEF_OUTPUT_DIR}/Resources/locales"
  )

  add_executable(process_helper WIN32
    src/native/win/process_helper_win.cpp
  )
  target_include_directories(process_helper PRIVATE
    src/native/shared
    "${CEF_ROOT}"
    "${CEF_ROOT}/include"
  )
  target_compile_definitions(process_helper PRIVATE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
    _CRT_SECURE_NO_WARNINGS
    UNICODE
    _UNICODE
  )
  target_link_libraries(process_helper PRIVATE
    libcef_dll_wrapper
    debug "${CEF_LIB_DEBUG}"
    optimized "${CEF_LIB_RELEASE}"
    ${CEF_STANDARD_LIBS}
    user32.lib
    advapi32.lib
    shell32.lib
    ole32.lib
  )
  target_link_options(process_helper PRIVATE /DELAYLOAD:libcef.dll)
  set_target_properties(process_helper PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${BUNITE_OUTPUT_DIR}"
  )
else()
  message(FATAL_ERROR "This initial Phase 1 CMake skeleton currently supports Windows only.")
endif()
