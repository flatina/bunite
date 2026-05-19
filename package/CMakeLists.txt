cmake_minimum_required(VERSION 3.20)

# Language enablement happens per-platform below.
project(bunite_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
add_compile_options("$<$<CXX_COMPILER_ID:MSVC>:/utf-8>")

# Platform/arch tags matching package/src/host/platform.ts PLATFORM_TAG and process.arch.
if(WIN32)
  set(BUNITE_PLATFORM_TAG "win")
  if(NOT DEFINED BUNITE_TARGET_ARCH)
    set(BUNITE_TARGET_ARCH x64)
  endif()
  set(BUNITE_ARCH_TAG "${BUNITE_TARGET_ARCH}")
elseif(APPLE)
  set(BUNITE_PLATFORM_TAG "mac")
  if(NOT DEFINED BUNITE_TARGET_ARCH)
    if(CMAKE_HOST_SYSTEM_PROCESSOR STREQUAL "arm64")
      set(BUNITE_TARGET_ARCH "arm64")
    else()
      set(BUNITE_TARGET_ARCH "x64")
    endif()
  endif()
  if(BUNITE_TARGET_ARCH STREQUAL "arm64")
    set(CMAKE_OSX_ARCHITECTURES "arm64")
    set(BUNITE_ARCH_TAG "arm64")
  elseif(BUNITE_TARGET_ARCH STREQUAL "x64")
    set(CMAKE_OSX_ARCHITECTURES "x86_64")
    set(BUNITE_ARCH_TAG "x64")
  else()
    message(FATAL_ERROR "Unsupported BUNITE_TARGET_ARCH for mac: ${BUNITE_TARGET_ARCH} (expected arm64 or x64)")
  endif()
elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  set(BUNITE_PLATFORM_TAG "linux")
  if(NOT DEFINED BUNITE_TARGET_ARCH)
    if(CMAKE_HOST_SYSTEM_PROCESSOR MATCHES "aarch64|arm64")
      set(BUNITE_TARGET_ARCH "arm64")
    else()
      set(BUNITE_TARGET_ARCH "x64")
    endif()
  endif()
  set(BUNITE_ARCH_TAG "${BUNITE_TARGET_ARCH}")
else()
  message(FATAL_ERROR "Unsupported platform for bunite-native.")
endif()

set(BUNITE_OUTPUT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/native-build/${BUNITE_PLATFORM_TAG}-${BUNITE_ARCH_TAG}")
file(MAKE_DIRECTORY "${BUNITE_OUTPUT_DIR}")

if(WIN32)
  set(BUNITE_CEF_OUTPUT_DIR "${BUNITE_OUTPUT_DIR}/cef")

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
    gdi32.lib
    windowscodecs.lib  # WIC PNG/JPEG encode for bunite_view_screenshot
    crypt32.lib        # CryptBinaryToString base64 encoding
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

  # ---- WebView2 adapter (BuniteNativeWebView2) --------------------------
  # Skeleton (Stage 1); behavior filled in by Stage 2-8. Built only when the
  # WebView2 SDK is present (run `bun run setup:webview2` first).
  if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/vendors/webview2/include/WebView2.h")
    set(WEBVIEW2_SDK "${CMAKE_CURRENT_SOURCE_DIR}/vendors/webview2")

    add_library(BuniteNativeWebView2 SHARED
      src/native/win-webview2/bunite_webview2_ffi.cpp
      src/native/win-webview2/webview2_runtime.cpp
      src/native/win-webview2/webview2_appres.cpp
      src/native/win-webview2/webview2_utils.cpp
    )
    target_include_directories(BuniteNativeWebView2 PRIVATE
      src/native/shared
      "${WEBVIEW2_SDK}/include"
    )
    target_compile_definitions(BuniteNativeWebView2 PRIVATE
      NOMINMAX
      WIN32_LEAN_AND_MEAN
      _CRT_SECURE_NO_WARNINGS
      UNICODE
      _UNICODE
    )
    target_link_libraries(BuniteNativeWebView2 PRIVATE
      "${WEBVIEW2_SDK}/lib-x64/WebView2LoaderStatic.lib"
      user32.lib
      advapi32.lib
      shell32.lib
      ole32.lib
      version.lib
      crypt32.lib  # CryptBinaryToString base64 for bunite_view_screenshot
    )
    set_target_properties(BuniteNativeWebView2 PROPERTIES
      OUTPUT_NAME "libBuniteNativeWebView2"
      RUNTIME_OUTPUT_DIRECTORY_RELEASE "${BUNITE_OUTPUT_DIR}"
      LIBRARY_OUTPUT_DIRECTORY_RELEASE "${BUNITE_OUTPUT_DIR}"
      ARCHIVE_OUTPUT_DIRECTORY_RELEASE "${BUNITE_OUTPUT_DIR}"
    )

    # Stage 0 spike — kept compilable as a side artifact for repeat measurement.
    add_executable(webview2_spike
      src/native/win-webview2/spike/main.cpp
    )
    target_include_directories(webview2_spike PRIVATE
      "${WEBVIEW2_SDK}/include"
    )
    target_compile_definitions(webview2_spike PRIVATE
      NOMINMAX
      WIN32_LEAN_AND_MEAN
      _CRT_SECURE_NO_WARNINGS
      UNICODE
      _UNICODE
    )
    target_link_libraries(webview2_spike PRIVATE
      "${WEBVIEW2_SDK}/lib-x64/WebView2LoaderStatic.lib"
      user32.lib
      advapi32.lib
      shell32.lib
      ole32.lib
      version.lib
    )
    set_target_properties(webview2_spike PROPERTIES
      RUNTIME_OUTPUT_DIRECTORY_RELEASE "${BUNITE_OUTPUT_DIR}"
    )
  endif()
elseif(APPLE)
  enable_language(OBJCXX)

  add_library(BuniteNative SHARED
    src/native/mac/bunite_mac_runtime.mm
    src/native/mac/bunite_mac_utils.mm
    src/native/mac/bunite_mac_appres.mm
    src/native/mac/bunite_mac_window.mm
    src/native/mac/bunite_mac_view.mm
    src/native/mac/bunite_mac_ffi.mm
  )
  target_include_directories(BuniteNative PRIVATE src/native/shared)
  target_compile_options(BuniteNative PRIVATE
    -fobjc-arc
    -Wall
    -Wextra
    -Wno-unused-parameter
  )
  target_link_libraries(BuniteNative PRIVATE
    "-framework AppKit"
    "-framework WebKit"
    "-framework Foundation"
    "-framework CoreGraphics"
    "-framework QuartzCore"
    "-framework UniformTypeIdentifiers"
  )
  set_target_properties(BuniteNative PROPERTIES
    OUTPUT_NAME "BuniteNative"            # → libBuniteNative.dylib
    PREFIX "lib"
    LIBRARY_OUTPUT_DIRECTORY "${BUNITE_OUTPUT_DIR}"
    INSTALL_NAME_DIR "@rpath"
    BUILD_WITH_INSTALL_RPATH ON
    MACOSX_RPATH ON
  )
elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(GTK4 REQUIRED gtk4)
  pkg_check_modules(WEBKITGTK REQUIRED webkitgtk-6.0)
  pkg_check_modules(JSON_GLIB REQUIRED json-glib-1.0)

  add_library(BuniteNative SHARED
    src/native/linux/bunite_linux_runtime.cpp
    src/native/linux/bunite_linux_utils.cpp
    src/native/linux/bunite_linux_appres.cpp
    src/native/linux/bunite_linux_preload.cpp
    src/native/linux/bunite_linux_window.cpp
    src/native/linux/bunite_linux_view.cpp
    src/native/linux/bunite_linux_ffi.cpp
  )
  target_include_directories(BuniteNative PRIVATE
    src/native/shared
    ${GTK4_INCLUDE_DIRS}
    ${WEBKITGTK_INCLUDE_DIRS}
    ${JSON_GLIB_INCLUDE_DIRS}
  )
  target_compile_options(BuniteNative PRIVATE
    -Wall -Wextra -Wno-unused-parameter -fPIC
    ${GTK4_CFLAGS_OTHER} ${WEBKITGTK_CFLAGS_OTHER} ${JSON_GLIB_CFLAGS_OTHER}
  )
  target_link_libraries(BuniteNative PRIVATE
    ${GTK4_LIBRARIES}
    ${WEBKITGTK_LIBRARIES}
    ${JSON_GLIB_LIBRARIES}
    pthread
  )
  set_target_properties(BuniteNative PROPERTIES
    OUTPUT_NAME "BuniteNative"            # → libBuniteNative.so
    PREFIX "lib"
    LIBRARY_OUTPUT_DIRECTORY "${BUNITE_OUTPUT_DIR}"
  )
endif()
