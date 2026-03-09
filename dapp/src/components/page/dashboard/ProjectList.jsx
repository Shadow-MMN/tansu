import { useStore } from "@nanostores/react";
import { useEffect, useState, useCallback, useRef } from "react";
import { getFeaturedProjectsConfigData } from "../../../constants/featuredProjectsConfigData.js";
import { fetchTomlFromIpfs } from "../../../utils/ipfsFunctions";
import {
  getProjectFromName,
  getMember,
  getProjectsPage,
} from "../../../service/ReadContractService";
import { convertGitHubLink } from "../../../utils/editLinkFunctions";
import {
  configData as configDataStore,
  projectCardModalOpen,
} from "../../../utils/store.ts";
import { extractConfigData } from "../../../utils/utils";
import CreateProjectModal from "./CreateProjectModal.tsx";
import ProjectCard from "./ProjectCard";
import ProjectInfoModal from "./ProjectInfoModal.jsx";
import MemberProfileModal from "./MemberProfileModal.tsx";
import Spinner from "components/utils/Spinner.tsx";

const ProjectList = () => {
  const isProjectInfoModalOpen = useStore(projectCardModalOpen);
  const configDataFromStore = useStore(configDataStore);
  const [projects, setProjects] = useState(undefined);
  const [filteredProjects, setFilteredProjects] = useState(undefined);
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isInOnChain, setIsInOnChain] = useState(false);
  const [configInfo, setConfigInfo] = useState();
  const [_prevPath, setPrevPath] = useState("");
  const [memberNotFound, setMemberNotFound] = useState(false);

  const [showProjectInfoModal, setShowProjectInfoModal] = useState(false);
  const [showCreateProjectModal, setShowCreateProjectModal] = useState(false);
  const [memberResult, setMemberResult] = useState(undefined);
  const [showMemberProfileModal, setShowMemberProfileModal] = useState(false);

  const [onChainProjects, setOnChainProjects] = useState([]);
  const [isLoadingOnChain, setIsLoadingOnChain] = useState(false);
  const [currentUIPage, setCurrentUIPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(true);

  // Define the handler function at component level so it's available everywhere
  const handleCreateProjectModal = useCallback(() => {
    setShowCreateProjectModal(true);
  }, []);

  // Function to handle closing the modal - simplified to match other modals
  const closeCreateProjectModal = useCallback(() => {
    setShowCreateProjectModal(false);
  }, []);

  useEffect(() => {
    const fetchProjects = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const data = getFeaturedProjectsConfigData();
      setProjects(data);
      setFilteredProjects(data);
    };

    fetchProjects();

    // Save previous path if coming from another page
    const referrer = document.referrer;
    if (referrer && !referrer.includes(window.location.host)) {
      setPrevPath(referrer);
    }

    // Check for search parameters in URL
    const searchParams = new URLSearchParams(window.location.search);
    const urlSearchTerm = searchParams.get("search");
    let searchTimeout;
    if (urlSearchTerm) {
      setSearchTerm(urlSearchTerm);
      // Set timeout to ensure projects are loaded before searching
      searchTimeout = setTimeout(() => handleSearch(), 300);
    }

    // Check if searching for a member
    const isMemberSearch = searchParams.get("member") === "true";
    if (isMemberSearch && urlSearchTerm) {
      handleMemberSearch(urlSearchTerm);
    }

    // Check for stored member profile
    const pendingMemberProfile = sessionStorage.getItem("pendingMemberProfile");
    if (pendingMemberProfile) {
      try {
        const memberData = JSON.parse(pendingMemberProfile);
        setMemberResult(memberData);
        setShowMemberProfileModal(true);
        sessionStorage.removeItem("pendingMemberProfile");
      } catch (e) {
        if (import.meta.env.DEV) {
          console.error("Error loading pending member profile", e);
        }
      }
    }

    // Check if we should open create project modal
    const openCreateProjectModal = sessionStorage.getItem(
      "openCreateProjectModal",
    );
    if (openCreateProjectModal === "true") {
      setShowCreateProjectModal(true);
      sessionStorage.removeItem("openCreateProjectModal");
    }

    // Add event listeners for navbar search
    window.addEventListener("search-projects", handleSearchProjectEvent);
    window.addEventListener("show-member-profile", handleMemberProfileEvent);
    window.addEventListener("search-member", handleSearchMemberEvent);

    // Add event listener for create project modal
    document.addEventListener(
      "show-create-project-modal",
      handleCreateProjectModal,
    );
    document.addEventListener(
      "create-project-global",
      handleCreateProjectModal,
    );

    return () => {
      if (searchTimeout) clearTimeout(searchTimeout);
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      window.removeEventListener("search-projects", handleSearchProjectEvent);
      window.removeEventListener(
        "show-member-profile",
        handleMemberProfileEvent,
      );
      window.removeEventListener("search-member", handleSearchMemberEvent);
      document.removeEventListener(
        "show-create-project-modal",
        handleCreateProjectModal,
      );
      document.removeEventListener(
        "create-project-global",
        handleCreateProjectModal,
      );
    };
  }, [handleCreateProjectModal]);

  const searchTimeoutRef = useRef(null);

  const handleSearchProjectEvent = useCallback((event) => {
    const term = event.detail;
    setSearchTerm(term);
    setMemberNotFound(false);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => handleSearch(), 100);
  }, []);

  const handleSearchMemberEvent = (event) => {
    const address = event.detail;
    setSearchTerm(address);
    handleMemberSearch(address);
  };

  const handleMemberProfileEvent = (event) => {
    const member = event.detail;
    setMemberResult(member);
    setShowMemberProfileModal(true);
  };

  useEffect(() => {
    if (projects && searchTerm) {
      handleSearch();
    }
  }, [projects, searchTerm]);

  useEffect(() => {
    setShowProjectInfoModal(isProjectInfoModalOpen);
  }, [isProjectInfoModalOpen]);

  const projectInfo = configDataFromStore
    ? {
        ...configDataFromStore,
        logoImageLink: configDataFromStore.logoImageLink
          ? convertGitHubLink(configDataFromStore.logoImageLink)
          : configDataFromStore.logoImageLink,
      }
    : null;

  const handleSearch = () => {
    if (!projects) return;

    setMemberNotFound(false);

    try {
      const filtered = projects.filter((project) => {
        // Safe check for null/undefined projectName
        return (
          project &&
          project.projectName &&
          project.projectName.toLowerCase().includes(searchTerm.toLowerCase())
        );
      });

      setFilteredProjects(filtered);

      if (searchTerm && filtered.length === 0) {
        checkProjectOnChain(searchTerm);
      }
    } catch (_) {
      // Remove console.error as it's an expected condition
      // Fallback to empty array on error
      setFilteredProjects([]);
    }
  };

  const checkProjectOnChain = async (projectName) => {
    setIsLoading(true);
    try {
      const project = await getProjectFromName(projectName);
      if (project && project.name && project.config && project.maintainers) {
        const tomlData = await fetchTomlFromIpfs(project.config.ipfs);
        if (tomlData) {
          const configData = extractConfigData(tomlData, project);
          setConfigInfo(configData);
        } else {
          const configData = {
            projectName: project.name,
            logoImageLink: undefined,
            thumbnailImageLink: "",
            description: "",
            organizationName: "",
            officials: {
              githubLink: project.config.url,
            },
            socialLinks: {},
            authorGithubNames: [],
            maintainersAddresses: project.maintainers,
          };
          setConfigInfo(configData);
        }
        setIsInOnChain(true);
      } else {
        setIsInOnChain(false);
        // No toast error for expected "not found" condition
      }
    } catch (_) {
      // No toast error for expected "not found" condition
      setIsInOnChain(false);
      // Remove console.error as it's an expected condition
    } finally {
      setIsLoading(false);
    }
  };

  const _handleClearSearch = () => {
    setSearchTerm("");
    setMemberNotFound(false);

    // Instead of navigating back, reload home page
    window.location.href = "/";
  };

  const handleMemberSearch = async (address) => {
    if (!address) return;

    setIsLoading(true);
    setMemberNotFound(false);

    try {
      const member = await getMember(address);
      if (member) {
        setMemberResult(member);
        setShowMemberProfileModal(true);
      } else {
        // No toast error for expected "not found" condition
        setMemberNotFound(true);
      }
    } catch (_) {
      // No toast error for expected "not found" condition
      setMemberNotFound(true);
    } finally {
      setIsLoading(false);
    }
  };

  const minimalConfig = (project) => ({
    projectName: project.name,
    logoImageLink: undefined,
    thumbnailImageLink: "",
    description: "",
    organizationName: "",
    officials: { githubLink: project.config.url },
    socialLinks: {},
    authorGithubNames: [],
    maintainersAddresses: project.maintainers,
  });

  const fetchProjectsForPage = async (uiPage) => {
    setIsLoadingOnChain(true);
    try {
      const blockchainPage = uiPage - 1;
      const projects = await getProjectsPage(blockchainPage);

      if (projects.length === 0) {
        setOnChainProjects([]);
        setHasNextPage(false);
        setIsLoadingOnChain(false);
        return;
      }

      const minimalList = projects.map(minimalConfig);
      setOnChainProjects(minimalList);
      setHasNextPage(true);
      setIsLoadingOnChain(false);

      const results = await Promise.allSettled(
        projects.map((p) => fetchTomlFromIpfs(p.config.ipfs)),
      );
      const enrichedList = projects.map((project, i) => {
        const result = results[i];
        const tomlData =
          result.status === "fulfilled" ? result.value : undefined;
        return tomlData
          ? extractConfigData(tomlData, project)
          : minimalConfig(project);
      });
      setOnChainProjects(enrichedList);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error("Error fetching projects for page:", uiPage, error);
      }
      setOnChainProjects([]);
      setHasNextPage(false);
      setIsLoadingOnChain(false);
import { useEffect, useState } from "react";

import { loadProjectName } from "@service/StateService";
import { navigate } from "astro:transitions/client";
import Button from "components/utils/Button";
import Modal from "../../utils/Modal";

const ProjectInfoModal = ({ id, projectInfo, onClose }) => {
  const [projectName, setProjectName] = useState("");

  const getProjectName = () => {
    const projectName = loadProjectName();
    if (projectName) {
      setProjectName(projectName);
    }
  };

  useEffect(() => {
    getProjectName();
  }, []);

  return (
    <Modal onClose={onClose}>
      {projectInfo && Object.keys(projectInfo).length > 0 ? (
        <>
          <div className="flex max-lg:flex-col gap-12">
            <img
              alt="Project Thumbnail"
              src={projectInfo?.logoImageLink || "/fallback-image.jpg"}
              className="w-[220px] h-[220px]"
            />
            <div className="flex-grow flex flex-col gap-[30px]">
              <div className="flex flex-col gap-3">
                <p className="leading-4 text-base font-medium text-primary">
                  {projectInfo?.organizationName || "No organization name"}
                </p>
                <h2 className="leading-6 text-2xl font-medium text-primary">
                  {projectInfo.projectFullName || projectInfo.projectName}
                </h2>
                <p className="leading-4 text-base text-secondary">
                  {projectInfo?.description || "No description"}
                </p>
              </div>
              <div className="grid lg:grid-cols-2 gap-[30px]">
                <div className="flex flex-col gap-3">
                  <h3 className="leading-4 text-base text-secondary">
                    Official Links
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {projectInfo?.officials &&
                      Object.entries(projectInfo.officials).map(
                        ([platform, link]) =>
                          link && (
                            <a
                              key={platform}
                              href={link}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <img
                                src={
                                  platform === "websiteLink"
                                    ? "/icons/logos/web.svg"
                                    : platform === "githubLink"
                                      ? "/icons/logos/github.svg"
                                      : ""
                                }
                                width={24}
                                height={24}
                                className={`icon-${platform}`}
                              />
                            </a>
                          ),
                      )}
                  </div>
                </div>
              </div>
              <div className="flex max-lg:flex-col gap-[18px]">
                <Button
                  icon="/icons/search-white.svg"
                  size="xl"
                  onClick={() => navigate(`/project?name=${projectName}`)}
                  className="whitespace-nowrap"
                >
                  View Details
                </Button>
                <Button
                  type="secondary"
                  icon="/icons/gear.svg"
                  size="xl"
                  onClick={() => navigate(`/governance?name=${projectName}`)}
                >
                  Governance
                </Button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="space-y-4">
          <h2 className="text-2xl sm:text-3xl font-bold">
            {projectName || "No project name"}
          </h2>
          <div className="h-40 flex items-center px-4 sm:px-8 pb-4">
            <p className="text-lg text-center">
              This project is missing a{" "}
              <a
                href="https://tansu.dev/docs/project_information_file"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 underline"
              >
                tansu.toml
              </a>{" "}
              configuration file.
            </p>
          </div>
          <div className="flex justify-end">
            <Button
              icon="/icons/search-white.svg"
              size="xl"
              onClick={() => navigate(`/project?name=${projectName}`)}
              className="whitespace-nowrap"
            >
              View Details
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
};

export default ProjectInfoModal;
