/**
 * The ModuleLoader is used for reading gir modules from the file system and to solve conflicts (e.g. Gtk-3.0 and Gtk-4.0 would be a conflict)
 */

import inquirer, { ListQuestion, Answers } from 'inquirer'
import { glob } from 'glob'
import { basename, join } from 'path'
import { bold } from 'colorette'
import {
    DependencyManager,
    ResolveType,
    GirModule,
    Logger,
    splitModuleName,
    union,
    isIterable,
    WARN_NO_GIR_FILE_FOUND_FOR_PACKAGE,
} from '@ts-for-gir/lib'
import { Config } from './config.js'

import type {
    GirModulesGroupedMap,
    OptionsGeneration,
    GirModuleResolvedBy,
    GirModulesGrouped,
    DependencyMap,
    Dependency,
    AnswerVersion,
} from '@ts-for-gir/lib'

export class ModuleLoader {
    log: Logger
    dependencyManager: DependencyManager
    /** Transitive module dependencies */
    modDependencyMap: DependencyMap = {}
    constructor(protected readonly config: OptionsGeneration) {
        this.log = new Logger(config.verbose, 'ModuleLoader')
        this.dependencyManager = DependencyManager.getInstance(config)
    }

    /**
     * Groups Gir modules by name id
     * E.g. Gtk-3.0 and Gtk-4.0 will be grouped
     * @param girFiles
     */
    protected groupGirFiles(resolveGirModules: Set<GirModuleResolvedBy> | GirModuleResolvedBy[]): GirModulesGroupedMap {
        const girModulesGrouped: GirModulesGroupedMap = {}

        for (const resolveGirModule of resolveGirModules) {
            const { namespace } = splitModuleName(resolveGirModule.packageName)
            const id = namespace.toLowerCase()

            if (!girModulesGrouped[id]) {
                girModulesGrouped[id] = {
                    namespace: namespace,
                    modules: [resolveGirModule],
                    hasConflict: false,
                }
            } else {
                girModulesGrouped[id].modules.push(resolveGirModule)
                girModulesGrouped[id].hasConflict = true
            }
        }

        return girModulesGrouped
    }

    /**
     * Sorts out the module the user has not selected via cli prompt
     * @param girModulesGrouped
     * @param selected Users selected module packageName
     */
    protected sortVersionsByAnswer(
        girModulesGrouped: GirModulesGrouped,
        selected: string[],
    ): { keep: Set<GirModuleResolvedBy>; ignore: string[] } {
        const keep = new Set<GirModuleResolvedBy>()
        let ignore: string[] = []

        if (!girModulesGrouped.hasConflict) {
            keep.add(girModulesGrouped.modules[0])
        } else {
            const keepModules = this.findGirModuleByFullNames(
                girModulesGrouped.modules,
                selected,
            ) as GirModuleResolvedBy[]
            const girModulePackageNames = girModulesGrouped.modules.map(
                (resolveGirModule) => resolveGirModule.packageName,
            )
            if (!keepModules || keepModules.length <= 0) {
                throw new Error('Module not found!')
            }
            for (const keepModule of keepModules) {
                keep.add(keepModule)
            }

            const toIgnore = girModulePackageNames.filter((packageName) => !selected.includes(packageName))
            ignore = ignore.concat(toIgnore)
        }

        return {
            keep,
            ignore,
        }
    }

    protected generateContinueQuestion(
        message = `do you want to continue?`,
        choices = ['Yes', 'Go back'],
    ): ListQuestion {
        const question: ListQuestion = {
            name: 'continue',
            message,
            type: 'list',
            choices,
        }
        return question
    }

    protected generateIgnoreDepsQuestion(
        message = `Do you want to ignore them too?`,
        choices = ['Yes', 'No', 'Go back'],
    ): ListQuestion {
        const question: ListQuestion = {
            name: 'continue',
            message,
            type: 'list',
            choices,
        }
        return question
    }

    protected async askIgnoreDepsPrompt(
        deps: GirModuleResolvedBy[] | Set<GirModuleResolvedBy>,
    ): Promise<'Yes' | 'No' | 'Go back'> {
        let question: ListQuestion<Answers> | null = null
        const size = (deps as GirModuleResolvedBy[]).length || (deps as Set<GirModuleResolvedBy>).size || 0
        if (size > 0) {
            this.log.log(bold('\nThe following modules have the ignored modules as dependencies:'))
            for (const dep of deps) {
                this.log.log(`- ${dep.packageName}`)
            }
            this.log.log(bold('\n'))
            question = this.generateIgnoreDepsQuestion()
        } else {
            this.log.log(bold('\nNo dependencies found on the ignored modules'))
            question = this.generateContinueQuestion()
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const answer: string = (await inquirer.prompt([question])).continue
        return answer as 'Yes' | 'No' | 'Go back'
    }

    /**
     * Ask for duplicates / multiple versions of a module
     * @param girModuleGrouped
     * @param message
     */
    protected generateModuleVersionQuestion(girModuleGrouped: GirModulesGrouped, message?: string): ListQuestion {
        message = message || `Multiple versions of '${girModuleGrouped.namespace}' found, which one do you want to use?`
        const choices = ['All', ...girModuleGrouped.modules.map((module) => module.packageName)]
        const question: ListQuestion = {
            name: girModuleGrouped.namespace,
            message,
            type: 'list',
            choices,
        }
        return question
    }

    /**
     * Find modules that depend on the module with the name 'packageName'
     * @param girModulesGroupedMap
     * @param packageName
     */
    protected findGirFilesDependOnPackage(
        girModulesGroupedMap: GirModulesGroupedMap,
        packageName: string,
    ): GirModuleResolvedBy[] {
        const girModules: GirModuleResolvedBy[] = []
        for (const girModulesGrouped of Object.values(girModulesGroupedMap)) {
            for (const girModuleResolvedBy of girModulesGrouped.modules) {
                if (girModuleResolvedBy.packageName === packageName) {
                    continue
                }
                for (const dep of girModuleResolvedBy.module.dependencies) {
                    if (dep.packageName === packageName && !girModules.includes(girModuleResolvedBy)) {
                        girModules.push(girModuleResolvedBy)
                    }
                }
            }
        }
        return girModules
    }

    /**
     * Find modules that depend on the module with the names in `packageNames`
     * @param girModulesGroupedMap
     * @param packageName
     */
    protected findGirFilesDependOnPackages(
        girModulesGroupedMap: GirModulesGroupedMap,
        packageNames: string[],
    ): GirModuleResolvedBy[] {
        let girModules: GirModuleResolvedBy[] = []
        for (const packageName of packageNames) {
            girModules = [...girModules, ...this.findGirFilesDependOnPackage(girModulesGroupedMap, packageName)]
        }
        return girModules
    }

    protected async askForVersionsPrompt(girModulesGrouped: GirModulesGrouped): Promise<AnswerVersion> {
        const question = this.generateModuleVersionQuestion(girModulesGrouped)
        const choices = question.choices as string[]
        if (!choices) {
            throw new Error('No valid questions!')
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const selected: string = (await inquirer.prompt([question]))[girModulesGrouped.namespace]
        if (!selected) {
            throw new Error('No valid answer!')
        }

        if (selected === 'All') {
            return {
                selected: choices.filter((choice) => choice !== 'All'),
                unselected: [],
            }
        }

        const unselected = choices.filter((choice) => choice !== selected)
        return {
            selected: [selected],
            unselected,
        }
    }

    /**
     * If multiple versions of the same module are found, this will aks the user with input prompts for the version he wish to use.
     * Ignores also modules that depend on a module that should be ignored
     * @param resolveFirModules
     */
    protected async askForEachConflictVersionsPrompt(
        girModulesGroupedMap: GirModulesGroupedMap,
        ignore: string[],
    ): Promise<{ keep: Set<GirModuleResolvedBy>; ignore: string[] }> {
        let keep = new Set<GirModuleResolvedBy>()
        for (const girModulesGrouped of Object.values(girModulesGroupedMap)) {
            // Remove ignored modules from group
            girModulesGrouped.modules = girModulesGrouped.modules.filter(
                (girGroup) => !ignore.includes(girGroup.packageName),
            )
            girModulesGrouped.hasConflict = girModulesGrouped.modules.length >= 2

            if (girModulesGrouped.modules.length <= 0) {
                continue
            }

            // Ask for version if there is a conflict
            if (!girModulesGrouped.hasConflict) {
                keep = union<GirModuleResolvedBy>(keep, girModulesGrouped.modules)
            } else {
                let goBack = true
                let versionAnswer: AnswerVersion | null = null
                let ignoreDepsAnswer: 'Yes' | 'No' | 'Go back' | null = null
                let wouldIgnoreDeps: GirModuleResolvedBy[] = []
                while (goBack) {
                    versionAnswer = await this.askForVersionsPrompt(girModulesGrouped)
                    // Check modules that depend on the unchosen modules
                    wouldIgnoreDeps = this.findGirFilesDependOnPackages(girModulesGroupedMap, versionAnswer.unselected)
                    // Do not check dependencies that have already been ignored
                    wouldIgnoreDeps = wouldIgnoreDeps.filter((dep) => !ignore.includes(dep.packageName))
                    ignoreDepsAnswer = await this.askIgnoreDepsPrompt(wouldIgnoreDeps)
                    goBack = ignoreDepsAnswer === 'Go back'
                }
                if (!versionAnswer) {
                    throw new Error('Error in processing the prompt versionAnswer')
                }

                if (ignoreDepsAnswer === 'Yes') {
                    // Also ignore the dependencies of the unselected version
                    ignore = ignore.concat(wouldIgnoreDeps.map((dep) => dep.packageName))
                }

                const unionMe = this.sortVersionsByAnswer(girModulesGrouped, versionAnswer.selected)
                // Do not ignore the selected package version
                keep = union<GirModuleResolvedBy>(keep, unionMe.keep)
                // Ignore the unchosen package versions
                ignore = ignore.concat(unionMe.ignore)
            }
        }
        if (ignore && ignore.length > 0) {
            const ignoreLogList = '- ' + ignore.join('\n- ')

            this.log.log(bold(`\n The following modules will be ignored:`))
            this.log.log(`\n${ignoreLogList}\n`)
            await this.askAddToIgnoreToConfigPrompt(ignore)
        }

        return {
            keep,
            ignore,
        }
    }

    /**
     * Asks via cli prompt if the user wants to add the ignored modules to his config file
     * @param ignoredModules
     */
    protected async askAddToIgnoreToConfigPrompt(ignoredModules: string[] | Set<string>): Promise<void> {
        const questions = [
            {
                name: 'addToIgnore',
                message: `Do you want to add the ignored modules to your config so that you don't need to select them again next time?\n  Config path: '${Config.configFilePath}`,
                type: 'list',
                choices: ['No', 'Yes'],
            },
        ]

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const answer: { [name: string]: string } = await inquirer.prompt(questions)

        if (answer.addToIgnore === 'Yes') {
            await Config.addToConfig({
                ignore: Array.from(ignoredModules),
            })
            this.log.log(`Add ignored modules to '${Config.configFilePath}'`)
        }
    }

    /**
     * Figure out transitive module dependencies
     * @param packageName
     * @param result
     */
    protected traverseDependencies(packageName: string, result: { [name: string]: Dependency } = {}): void {
        const deps = this.modDependencyMap[packageName]
        if (isIterable(deps)) {
            for (const dep of deps) {
                if (result[dep.packageName]) continue
                result[dep.packageName] = dep
                this.traverseDependencies(dep.packageName, result)
            }
        }
    }

    /**
     * Extends the modDependencyMap by the current Module,
     * should be called for each girModule so that the modDependencyMap is complete
     * @param girModule
     */
    protected extendDependencyMapByGirModule(girModule: GirModule): void {
        this.modDependencyMap[girModule.packageName] = girModule.dependencies!
    }

    /**
     * Sets the traverse dependencies for the current girModule,
     * is required so that all dependencies can be found internally when generating the dependency imports for the module .d.ts file
     * @param girModules
     */
    protected async initGirModules(girModules: GirModuleResolvedBy[]): Promise<void> {
        for (const girModule of girModules) {
            const result: { [name: string]: Dependency } = {}
            this.traverseDependencies(girModule.packageName, result)
            await girModule.module.initTransitiveDependencies(Object.values(result))
        }
    }

    /**
     * Reads a gir xml module file and creates an object of GirModule.
     * Also sets the setDependencyMap
     * @param fillName
     * @param config
     */
    protected async loadAndCreateGirModule(dependency: Dependency): Promise<GirModule | null> {
        if (!dependency.exists || dependency.path === null) {
            return null
        }

        this.log.log(`Loading ${dependency.packageName}...`)
        const girModule = await GirModule.load(dependency, this.config, this.dependencyManager)
        // Figure out transitive module dependencies
        this.extendDependencyMapByGirModule(girModule)
        return girModule
    }

    /**
     * Returns a girModule found by `packageName` property
     * @param girModules Array of girModules
     * @param packageNames Full name like 'Gtk-3.0' you are looking for
     */
    protected findGirModuleByFullNames(
        girModules: (GirModuleResolvedBy | GirModule)[],
        packageNames: string[],
    ): Array<GirModuleResolvedBy | GirModule> {
        return girModules.filter((girModule) => packageNames.includes(girModule.packageName))
    }

    /**
     * Checks if a girModules with the `packageNames` exists
     * @param girModules
     * @param packageName
     */
    protected existsGirModules(girModules: (GirModuleResolvedBy | GirModule)[], packageName: string): boolean {
        const foundModule = this.findGirModuleByFullNames(girModules, [packageName])
        return foundModule.length > 0
    }

    /**
     *  Reads the gir xml module files and creates an object of GirModule for each module
     * @param dependencies
     * @param girModules
     * @param resolvedBy
     * @param failedGirModules
     * @param ignoreDependencies
     * @returns
     */
    protected async loadGirModules(
        dependencies: Dependency[],
        ignoreDependencies: string[] = [],
        girModules: GirModuleResolvedBy[] = [],
        resolvedBy = ResolveType.BY_HAND,
        failedGirModules = new Set<string>(),
    ): Promise<{ loaded: GirModuleResolvedBy[]; failed: Set<string> }> {
        let newModuleFound = false

        // Clone array
        dependencies = [...dependencies]

        while (dependencies.length > 0) {
            const dependency = dependencies.shift()
            if (!dependency?.packageName) continue
            // If module has not already been loaded
            if (!this.existsGirModules(girModules, dependency.packageName)) {
                const girModule = await this.loadAndCreateGirModule(dependency)
                if (!girModule) {
                    if (!failedGirModules.has(dependency.packageName)) {
                        this.log.warn(WARN_NO_GIR_FILE_FOUND_FOR_PACKAGE(dependency.packageName))
                        failedGirModules.add(dependency.packageName)
                    }
                } else if (girModule && girModule.packageName) {
                    const addModule = {
                        packageName: girModule.packageName,
                        module: girModule,
                        resolvedBy,
                        path: dependency.path,
                    }
                    girModules.push(addModule)
                    newModuleFound = true
                }
            }
        }

        if (!newModuleFound) {
            return {
                loaded: girModules,
                failed: failedGirModules,
            }
        }

        // Figure out transitive module dependencies
        await this.initGirModules(girModules)

        // Load girModules for dependencies
        for (const girModule of girModules) {
            // Load dependencies
            const transitiveDependencies = girModule.module.transitiveDependencies
            if (transitiveDependencies.length > 0) {
                await this.loadGirModules(
                    transitiveDependencies,
                    ignoreDependencies,
                    girModules,
                    ResolveType.DEPENDENCE,
                    failedGirModules,
                )
            }
        }

        return {
            loaded: girModules,
            failed: failedGirModules,
        }
    }

    /**
     * Find modules with the possibility to use wild cards for module names. E.g. `Gtk*` or `'*'`
     * @param modules
     * @param ignore
     */
    protected async findGirFiles(globPackageNames: string[], ignore: string[] = []): Promise<Set<string>> {
        const foundFiles = new Set<string>()

        for (let i = 0; i < globPackageNames.length; i++) {
            if (!globPackageNames[i]) {
                continue
            }
            const filename = `${globPackageNames[i]}.gir`
            const pattern = this.config.girDirectories.map((girDirectory) => join(girDirectory, filename))
            const ignoreGirs = ignore.map((girDirectory) => girDirectory + '.gir')
            const files = await glob(pattern, { ignore: ignoreGirs })
            files.forEach((file) => foundFiles.add(file))
        }

        return foundFiles
    }

    protected async girFilePathToDependencies(girFiles: Set<string>): Promise<Dependency[]> {
        const dependencies: Dependency[] = []
        for (const girFile of girFiles) {
            const packageName = basename(girFile, '.gir')
            const { namespace, version } = splitModuleName(packageName)
            const dep = await this.dependencyManager.get(namespace, version)
            dependencies.push(dep)
        }

        return dependencies
    }

    /**
     * Loads all found `packageNames`
     * @param girDirectories
     * @param packageNames
     * @param doNotAskForVersionOnConflict Set this to false if you want to get a prompt for each version conflict
     */
    public async getModulesResolved(
        packageNames: string[],
        ignore: string[] = [],
        doNotAskForVersionOnConflict = true,
    ): Promise<{ keep: GirModuleResolvedBy[]; grouped: GirModulesGroupedMap; ignore: string[]; failed: Set<string> }> {
        const girFiles = await this.findGirFiles([...packageNames], ignore)
        // Always require these because GJS does...
        const GLib = await this.dependencyManager.get('GLib', '2.0')
        const Gio = await this.dependencyManager.get('Gio', '2.0')
        const GObject = await this.dependencyManager.get('GObject', '2.0')

        const dependencies = await this.girFilePathToDependencies(girFiles)

        const { loaded, failed } = await this.loadGirModules(
            [
                GLib,
                Gio,
                GObject,
                ...dependencies.filter(
                    (dep) => dep.namespace !== 'GLib' && dep.namespace !== 'Gio' && dep.namespace !== 'GObject',
                ),
            ],
            ignore,
        )
        let keep: GirModuleResolvedBy[] = []
        if (doNotAskForVersionOnConflict) {
            keep = loaded
        } else {
            const girModulesGrouped = this.groupGirFiles(loaded)
            const filtered = await this.askForEachConflictVersionsPrompt(girModulesGrouped, ignore)
            keep = Array.from(filtered.keep)
        }

        const grouped = this.groupGirFiles(keep)

        return { keep, grouped, ignore, failed }
    }

    /**
     * Find modules
     * @param girDirectories
     * @param modules
     */
    public async getModules(
        modules: string[],
        ignore: string[] = [],
    ): Promise<{ grouped: GirModulesGroupedMap; loaded: GirModuleResolvedBy[]; failed: string[] }> {
        const girFiles = await this.findGirFiles(modules, ignore)
        const dependencies = await this.girFilePathToDependencies(girFiles)
        const { loaded, failed } = await this.loadGirModules(dependencies, ignore)
        const grouped = this.groupGirFiles(loaded)
        return { grouped, loaded, failed: Array.from(failed) }
    }

    /** Start parsing the gir modules */
    public parse(girModules: GirModuleResolvedBy[]): void {
        for (const girModule of girModules) {
            girModule.module.parse()
        }
    }
}
