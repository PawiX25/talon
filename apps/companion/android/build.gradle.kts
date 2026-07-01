allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

// Force every Android plugin subproject to compile against API 36. Some plugins
// (file_picker's flutter_plugin_android_lifecycle) require compileSdk >= 36, but
// each plugin otherwise inherits Flutter's default (34), which fails the build.
// Setting it on the app module alone doesn't propagate to the plugin subprojects.
// Configure as the Android library plugin is applied — `afterEvaluate` is too
// late here because `evaluationDependsOn(":app")` above forces early evaluation.
subprojects {
    plugins.withId("com.android.library") {
        (extensions.findByName("android") as? com.android.build.gradle.BaseExtension)
            ?.compileSdkVersion(36)
    }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
